using System;
using System.Collections.Generic;

namespace SGI
{
    /// <summary>
    /// KCP 可靠 UDP 协议实现（纯 C# 移植）
    ///
    /// 对应 src/core/utils/kcp.ts 的 C# 移植。算法与 TS 版一致：
    /// ARQ 重传 / 滑动窗口 / 拥塞控制 / 快速重传。
    /// 所有 32 位字段使用 uint 表示，差值比较使用 long 以复现 TS 的
    /// 双精度算术语义（TS 中 sn - sndUna 为有符号比较）。
    /// </summary>
    internal class Kcp
    {
        private const uint KcpRtoNdl = 30;
        private const uint KcpRtoMin = 100;
        private const uint KcpRtoDef = 200;
        private const uint KcpRtoMax = 60000;

        private const byte KcpCmdPush = 81;
        private const byte KcpCmdAck = 82;
        private const byte KcpCmdWask = 83;
        private const byte KcpCmdWins = 84;

        private const uint KcpAskSend = 1;
        private const uint KcpAskTell = 2;

        private const ushort KcpWndSnd = 32;
        private const ushort KcpWndRcv = 256;

        private const int KcpMtuDef = 1400;
        private const int KcpInterval = 100;
        private const int KcpOverhead = 28;

        private const ushort KcpThreshInit = 2;
        private const ushort KcpThreshMin = 2;

        private const uint KcpProbeInit = 7000;
        private const uint KcpProbeLimit = 120000;

        private static readonly byte[] Empty = new byte[0];

        internal class KcpSegment
        {
            public uint Conv;
            public uint Token;
            public byte Cmd;
            public byte Frg;
            public ushort Wnd;
            public uint Ts;
            public uint Sn;
            public uint Una;
            public uint ResendTs;
            public uint Rto;
            public uint FastAck;
            public uint Xmit;
            public byte[] Data;
        }

        /// <summary>Conversation ID</summary>
        public readonly uint Conv;
        /// <summary>User token</summary>
        public readonly uint Token;

        private int _mtu;
        private uint _mss;
        private int _state;

        private uint _sndUna;
        private uint _sndNxt;
        private uint _rcvNxt;

        private ushort _ssThresh;

        private uint _rxRttVal;
        private uint _rxsRtt;
        private uint _rxRto;
        private uint _rxMinRto;

        private ushort _sndWnd;
        private ushort _rcvWnd;
        private ushort _rmtWnd;
        private ushort _cWnd;
        private uint _probe;

        private uint _current;
        private uint _interval;
        private uint _tsFlush;

        private bool _nodelay;
        private bool _updated;

        private uint _tsProbe;
        private uint _probeWait;

        private uint _deadLink;
        private uint _incr;

        private readonly List<KcpSegment> _sndQueue = new List<KcpSegment>();
        private readonly List<KcpSegment> _rcvQueue = new List<KcpSegment>();
        private readonly List<KcpSegment> _sndBuf = new List<KcpSegment>();
        private readonly List<KcpSegment> _rcvBuf = new List<KcpSegment>();
        private readonly List<AckEntry> _acklist = new List<AckEntry>();

        private byte[] _buf;
        private int _bufOffset;

        private uint _fastResend;
        private bool _nocwnd;
        private bool _stream;

        private readonly Action<byte[]> _output;

        internal struct AckEntry
        {
            public uint Sn;
            public uint Ts;
        }

        /// <summary>
        /// 功能描述：构造 KCP 实例
        ///
        /// @param conv - 会话 ID
        /// @param token - 用户令牌
        /// @param output - 底层 UDP 输出回调（消费者必须拷贝 buffer 内容）
        /// @param stream - 是否流模式
        /// </summary>
        public Kcp(uint conv, uint token, Action<byte[]> output, bool stream = false)
        {
            Conv = conv;
            Token = token;
            _state = 0;
            _cWnd = 0;
            _probe = 0;
            _current = 0;
            _nodelay = false;
            _updated = false;
            _tsProbe = 0;
            _probeWait = 0;
            _deadLink = 10;
            _incr = 0;
            _fastResend = 0;
            _nocwnd = false;
            _stream = stream;
            _sndWnd = KcpWndSnd;
            _rcvWnd = KcpWndRcv;
            _rmtWnd = KcpWndRcv;
            _mtu = KcpMtuDef;
            _mss = (uint)(KcpMtuDef - KcpOverhead);
            _buf = new byte[(KcpMtuDef + KcpOverhead) * 3];
            _bufOffset = 0;
            _rxRto = KcpRtoDef;
            _rxMinRto = KcpRtoMin;
            _interval = KcpInterval;
            _tsFlush = KcpInterval;
            _ssThresh = KcpThreshInit;
            _output = output;
        }

        /// <summary>
        /// 功能描述：从原始包读取 conv
        ///
        /// @param packet - KCP 包
        /// </summary>
        public static uint GetConv(byte[] packet)
        {
            return ReadUInt32LE(packet, 0);
        }

        /// <summary>
        /// 功能描述：写入 conv 到原始包
        ///
        /// @param packet - KCP 包
        /// @param conv - 会话 ID
        /// </summary>
        public static void SetConv(byte[] packet, uint conv)
        {
            WriteUInt32LE(packet, 0, conv);
        }

        /// <summary>
        /// 功能描述：从原始包读取 token
        ///
        /// @param packet - KCP 包
        /// </summary>
        public static uint GetToken(byte[] packet)
        {
            return ReadUInt32LE(packet, 4);
        }

        /// <summary>
        /// 功能描述：写入 token 到原始包
        ///
        /// @param packet - KCP 包
        /// @param token - 用户令牌
        /// </summary>
        public static void SetToken(byte[] packet, uint token)
        {
            WriteUInt32LE(packet, 4, token);
        }

        private static KcpSegment CreateSegment(byte[] data)
        {
            return new KcpSegment { Data = data };
        }

        /// <summary>
        /// 功能描述：序列化 KCP 段到缓冲区
        ///
        /// @param buf - 目标缓冲区
        /// @param seg - KCP 段
        /// @returns 写入的字节数
        /// </summary>
        private static int EncodeSegment(byte[] buf, KcpSegment seg)
        {
            int size = KcpOverhead + seg.Data.Length;
            if (buf.Length < size)
            {
                throw new Exception($"buffer too small to encode kcp segment of size {size}");
            }
            WriteUInt32LE(buf, 0, seg.Conv);
            WriteUInt32LE(buf, 4, seg.Token);
            buf[8] = seg.Cmd;
            buf[9] = seg.Frg;
            WriteUInt16LE(buf, 10, seg.Wnd);
            WriteUInt32LE(buf, 12, seg.Ts);
            WriteUInt32LE(buf, 16, seg.Sn);
            WriteUInt32LE(buf, 20, seg.Una);
            WriteUInt32LE(buf, 24, (uint)seg.Data.Length);
            Buffer.BlockCopy(seg.Data, 0, buf, 28, seg.Data.Length);
            return size;
        }

        /// <summary>
        /// 功能描述：检查可读取的数据大小（不消费）
        ///
        /// @returns 数据长度，-1 表示数据未完整
        /// </summary>
        public int PeekSize()
        {
            if (_rcvQueue.Count == 0)
            {
                return -1;
            }
            var segment = _rcvQueue[0];
            if (segment.Frg == 0)
            {
                return segment.Data.Length;
            }
            if (_rcvQueue.Count < segment.Frg + 1)
            {
                return -1;
            }
            int len = 0;
            for (int i = 0; i < _rcvQueue.Count; i++)
            {
                len += _rcvQueue[i].Data.Length;
                if (_rcvQueue[i].Frg == 0)
                {
                    break;
                }
            }
            return len;
        }

        /// <summary>
        /// 功能描述：将 rcv_buf 中连续数据移到 rcv_queue
        /// </summary>
        private void MoveBuf()
        {
            while (_rcvBuf.Count > 0)
            {
                int nrcvQueue = _rcvQueue.Count;
                var seg = _rcvBuf[0];
                if (seg.Sn == _rcvNxt && nrcvQueue < _rcvWnd)
                {
                    _rcvNxt += 1;
                }
                else
                {
                    break;
                }
                _rcvBuf.RemoveAt(0);
                _rcvQueue.Add(seg);
            }
        }

        /// <summary>
        /// 功能描述：从缓冲区接收数据
        ///
        /// @param buf - 目标缓冲区
        /// @param offset - 写入偏移
        /// @returns 读取的字节数，负数表示错误
        /// </summary>
        public int Recv(byte[] buf, int offset = 0)
        {
            if (buf == null || _rcvQueue.Count == 0)
            {
                return -1;
            }
            int peekSize = PeekSize();
            if (peekSize < 0) return -2;
            if (peekSize > buf.Length - offset) return -3;

            bool recover = _rcvQueue.Count >= _rcvWnd;

            // Merge fragment
            while (_rcvQueue.Count > 0)
            {
                var seg = _rcvQueue[0];
                _rcvQueue.RemoveAt(0);
                Buffer.BlockCopy(seg.Data, 0, buf, offset, seg.Data.Length);
                offset += seg.Data.Length;
                if (seg.Frg == 0)
                {
                    break;
                }
            }

            MoveBuf();

            // fast recover
            if (_rcvQueue.Count < _rcvWnd && recover)
            {
                _probe |= KcpAskTell;
            }

            return peekSize;
        }

        /// <summary>
        /// 功能描述：发送字节到缓冲区
        ///
        /// @param buf - 要发送的数据
        /// @returns 发送的字节数，负数表示错误
        /// </summary>
        public int Send(byte[] buf)
        {
            if (buf == null)
            {
                return -1;
            }

            int sentSize = 0;

            // append to previous segment in streaming mode (if possible)
            if (_stream && _sndQueue.Count > 0)
            {
                var old = _sndQueue[_sndQueue.Count - 1];
                int l = old.Data.Length;
                if (l < _mss)
                {
                    int capacity = (int)(_mss - l);
                    int extend = Math.Min(buf.Length, capacity);

                    var lf = new byte[extend];
                    Buffer.BlockCopy(buf, 0, lf, 0, extend);
                    var merged = new byte[old.Data.Length + extend];
                    Buffer.BlockCopy(old.Data, 0, merged, 0, old.Data.Length);
                    Buffer.BlockCopy(lf, 0, merged, old.Data.Length, extend);
                    old.Data = merged;
                    old.Frg = 0;
                    sentSize += extend;

                    var rest = new byte[buf.Length - extend];
                    Buffer.BlockCopy(buf, extend, rest, 0, rest.Length);
                    buf = rest;
                }

                if (buf.Length == 0)
                {
                    return sentSize;
                }
            }

            int count;
            if (buf.Length <= _mss)
            {
                count = 1;
            }
            else
            {
                count = (int)Math.Ceiling(buf.Length / (double)_mss);
            }

            if (count >= KcpWndRcv)
            {
                return -2;
            }

            for (int i = 0; i < count; i++)
            {
                int size = (int)Math.Min(_mss, buf.Length);
                var lf = new byte[size];
                Buffer.BlockCopy(buf, 0, lf, 0, size);
                var rest = new byte[buf.Length - size];
                Buffer.BlockCopy(buf, size, rest, 0, rest.Length);
                buf = rest;

                var newSegment = CreateSegment(lf);

                if (_stream)
                {
                    newSegment.Frg = 0;
                }
                else
                {
                    newSegment.Frg = (byte)((count - i - 1) & 0xFF);
                }

                _sndQueue.Add(newSegment);
                sentSize += size;
            }

            return sentSize;
        }

        private void UpdateAck(uint rtt)
        {
            if (_rxsRtt == 0)
            {
                _rxsRtt = rtt;
                _rxRttVal = (uint)(rtt / 2);
            }
            else
            {
                long delta;
                if (rtt > _rxsRtt)
                {
                    delta = rtt - _rxsRtt;
                }
                else
                {
                    delta = _rxsRtt - rtt;
                }
                _rxRttVal = (uint)((3 * (long)_rxRttVal + delta) / 4);
                _rxsRtt = (uint)((7 * (long)_rxsRtt + rtt) / 8);
                if (_rxsRtt < 1)
                {
                    _rxsRtt = 1;
                }
            }

            long rto = _rxsRtt + Math.Max(_interval, 4 * _rxRttVal);
            _rxRto = (uint)Math.Max(_rxMinRto, Math.Min(rto, KcpRtoMax));
        }

        private void ShrinkBuf()
        {
            if (_sndBuf.Count > 0)
            {
                _sndUna = _sndBuf[0].Sn;
            }
            else
            {
                _sndUna = _sndNxt;
            }
        }

        private void ParseAck(uint sn)
        {
            if ((long)sn - _sndUna < 0 || (long)sn - _sndNxt >= 0)
            {
                return;
            }
            for (int i = 0; i < _sndBuf.Count; i++)
            {
                var seg = _sndBuf[i];
                if (sn == seg.Sn)
                {
                    _sndBuf.RemoveAt(i);
                }
                else if (sn < seg.Sn)
                {
                    break;
                }
            }
        }

        private void ParseUna(uint una)
        {
            while (_sndBuf.Count > 0)
            {
                if ((long)una - _sndBuf[0].Sn > 0)
                {
                    _sndBuf.RemoveAt(0);
                }
                else
                {
                    break;
                }
            }
        }

        private void ParseFastAck(uint sn)
        {
            if ((long)sn - _sndUna < 0 || (long)sn - _sndNxt >= 0)
            {
                return;
            }
            for (int i = 0; i < _sndBuf.Count; i++)
            {
                var seg = _sndBuf[i];
                if ((long)sn - seg.Sn < 0)
                {
                    break;
                }
                else if (sn != seg.Sn)
                {
                    seg.FastAck += 1;
                }
            }
        }

        private void AckPush(uint sn, uint ts)
        {
            _acklist.Add(new AckEntry { Sn = sn, Ts = ts });
        }

        private void ParseData(KcpSegment newSegment)
        {
            uint sn = newSegment.Sn;

            if ((long)sn - ((long)_rcvNxt + _rcvWnd) >= 0 || (long)sn - _rcvNxt < 0)
            {
                return;
            }

            bool repeat = false;
            int newIndex = _rcvBuf.Count;

            for (int i = _rcvBuf.Count - 1; i >= 0; i--)
            {
                var segment = _rcvBuf[i];
                if (segment.Sn == sn)
                {
                    repeat = true;
                    break;
                }
                else if ((long)sn - segment.Sn > 0)
                {
                    break;
                }
                newIndex -= 1;
            }

            if (!repeat)
            {
                _rcvBuf.Insert(newIndex, newSegment);
            }

            MoveBuf();
        }

        /// <summary>
        /// 功能描述：接收来自底层 UDP 连接的原始包
        ///
        /// @param buf - 原始包数据
        /// @returns 读取的字节数，负数表示错误
        /// </summary>
        public int Input(byte[] buf)
        {
            if (buf == null || buf.Length < KcpOverhead)
            {
                return -1;
            }

            int totalRead = 0;
            bool flag = false;
            uint maxAck = 0;
            uint oldUna = _sndUna;

            int pos = 0;
            while (buf.Length - pos >= KcpOverhead)
            {
                uint conv = ReadUInt32LE(buf, pos);
                uint token = ReadUInt32LE(buf, pos + 4);
                byte cmd = buf[pos + 8];
                byte frg = buf[pos + 9];
                ushort wnd = ReadUInt16LE(buf, pos + 10);
                uint ts = ReadUInt32LE(buf, pos + 12);
                uint sn = ReadUInt32LE(buf, pos + 16);
                uint una = ReadUInt32LE(buf, pos + 20);
                int len = (int)ReadUInt32LE(buf, pos + 24);

                if (conv != Conv)
                {
                    return -1;
                }
                if (token != Token)
                {
                    return -1;
                }
                if (buf.Length - pos - KcpOverhead < len)
                {
                    return -2;
                }

                if (cmd != KcpCmdPush && cmd != KcpCmdAck && cmd != KcpCmdWask && cmd != KcpCmdWins)
                {
                    return -3;
                }

                _rmtWnd = wnd;

                ParseUna(una);
                ShrinkBuf();

                switch (cmd)
                {
                    case KcpCmdAck:
                        {
                            long rtt = (long)_current - ts;
                            if (rtt >= 0)
                            {
                                UpdateAck((uint)rtt);
                            }
                            ParseAck(sn);
                            ShrinkBuf();
                            if (!flag)
                            {
                                maxAck = sn;
                                flag = true;
                            }
                            else if ((long)sn - maxAck > 0)
                            {
                                maxAck = sn;
                            }
                            break;
                        }
                    case KcpCmdPush:
                        {
                            if ((long)sn - ((long)_rcvNxt + _rcvWnd) < 0)
                            {
                                AckPush(sn, ts);
                                if ((long)sn - _rcvNxt >= 0)
                                {
                                    var sdata = new byte[len];
                                    Buffer.BlockCopy(buf, pos + KcpOverhead, sdata, 0, len);
                                    var segment = CreateSegment(sdata);
                                    segment.Conv = conv;
                                    segment.Token = token;
                                    segment.Cmd = cmd;
                                    segment.Frg = frg;
                                    segment.Wnd = wnd;
                                    segment.Ts = ts;
                                    segment.Sn = sn;
                                    segment.Una = una;
                                    ParseData(segment);
                                }
                            }
                            break;
                        }
                    case KcpCmdWask:
                        {
                            _probe |= KcpAskTell;
                            break;
                        }
                    case KcpCmdWins:
                        {
                            // Do nothing
                            break;
                        }
                }

                totalRead += KcpOverhead + len;
                pos += KcpOverhead + len;
            }

            if (flag)
            {
                ParseFastAck(maxAck);
            }

            if (_sndUna > oldUna && _cWnd < _rmtWnd)
            {
                uint mss = _mss;
                if (_cWnd < _ssThresh)
                {
                    _cWnd += 1;
                    _incr += mss;
                }
                else
                {
                    if (_incr < mss)
                    {
                        _incr = mss;
                    }
                    _incr += (uint)(mss * mss / (double)_incr) + (uint)(mss / 16);
                    if ((_cWnd + 1) * mss <= _incr)
                    {
                        _cWnd += 1;
                    }
                }
                if (_cWnd > _rmtWnd)
                {
                    _cWnd = _rmtWnd;
                    _incr = _rmtWnd * mss;
                }
            }

            return totalRead;
        }

        private uint WndUnused()
        {
            if (_rcvQueue.Count < _rcvWnd)
            {
                return (uint)(_rcvWnd - (_rcvQueue.Count & 0xFFFF));
            }
            return 0;
        }

        private void FlushAckInternal(KcpSegment segment)
        {
            for (int i = 0; i < _acklist.Count; i++)
            {
                var ack = _acklist[i];
                if (_bufOffset + KcpOverhead > _mtu)
                {
                    OutputSlice();
                }
                segment.Sn = ack.Sn;
                segment.Ts = ack.Ts;
                _bufOffset += EncodeSegmentSlice(segment);
            }
            _acklist.Clear();
        }

        private void ProbeWndSize()
        {
            if (_rmtWnd == 0)
            {
                if (_probeWait == 0)
                {
                    _probeWait = KcpProbeInit;
                    _tsProbe = _current + _probeWait;
                }
                else
                {
                    if ((long)_current - _tsProbe >= 0 && _probeWait < KcpProbeInit)
                    {
                        _probeWait = KcpProbeInit;
                    }
                    _probeWait += (uint)(_probeWait / 2);
                    if (_probeWait > KcpProbeLimit)
                    {
                        _probeWait = KcpProbeLimit;
                    }
                    _tsProbe = _current + _probeWait;
                    _probe |= KcpAskSend;
                }
            }
            else
            {
                _tsProbe = 0;
                _probeWait = 0;
            }
        }

        private void FlushProbeCommandsInternal(byte cmd, KcpSegment segment)
        {
            segment.Cmd = cmd;
            if (_bufOffset + KcpOverhead > _mtu)
            {
                OutputSlice();
            }
            _bufOffset += EncodeSegmentSlice(segment);
        }

        private void FlushProbeCommands(KcpSegment segment)
        {
            if ((_probe & KcpAskSend) != 0)
            {
                FlushProbeCommandsInternal(KcpCmdWask, segment);
            }
            if ((_probe & KcpAskTell) != 0)
            {
                FlushProbeCommandsInternal(KcpCmdWins, segment);
            }
            _probe = 0;
        }

        /// <summary>
        /// 功能描述：刷新挂起的 ACK
        /// </summary>
        public void FlushAck()
        {
            if (!_updated)
            {
                return;
            }
            var segment = CreateSegment(Empty);
            segment.Conv = Conv;
            segment.Cmd = KcpCmdAck;
            segment.Wnd = (ushort)WndUnused();
            segment.Una = _rcvNxt;
            FlushAckInternal(segment);
        }

        /// <summary>
        /// 功能描述：刷新缓冲区中的待发数据
        /// </summary>
        public void Flush()
        {
            if (!_updated)
            {
                return;
            }

            var segment = CreateSegment(Empty);
            segment.Conv = Conv;
            segment.Token = Token;
            segment.Cmd = KcpCmdAck;
            segment.Wnd = (ushort)WndUnused();
            segment.Una = _rcvNxt;

            FlushAckInternal(segment);
            ProbeWndSize();
            FlushProbeCommands(segment);

            // calculate window size
            uint cWnd = Math.Min(_sndWnd, _rmtWnd);
            if (!_nocwnd)
            {
                cWnd = Math.Min(_cWnd, cWnd);
            }

            // move data from snd_queue to snd_buf
            while ((long)_sndNxt - ((long)_sndUna + cWnd) < 0)
            {
                if (_sndQueue.Count == 0)
                {
                    break;
                }
                var newSegment = _sndQueue[0];
                _sndQueue.RemoveAt(0);

                newSegment.Conv = Conv;
                newSegment.Token = Token;
                newSegment.Cmd = KcpCmdPush;
                newSegment.Wnd = segment.Wnd;
                newSegment.Ts = _current;
                newSegment.Sn = _sndNxt;
                _sndNxt += 1;
                newSegment.Una = _rcvNxt;
                newSegment.ResendTs = _current;
                newSegment.Rto = _rxRto;
                newSegment.FastAck = 0;
                newSegment.Xmit = 0;
                _sndBuf.Add(newSegment);
            }

            // calculate resent
            uint resent = _fastResend > 0 ? _fastResend : 0xffffffff;
            uint rtoMin = !_nodelay ? (uint)(_rxRto >> 3) : 0;

            bool lost = false;
            uint change = 0;

            for (int i = 0; i < _sndBuf.Count; i++)
            {
                var sndSegment = _sndBuf[i];
                bool needSend = false;

                if (sndSegment.Xmit == 0)
                {
                    needSend = true;
                    sndSegment.Xmit += 1;
                    sndSegment.Rto = _rxRto;
                    sndSegment.ResendTs = _current + sndSegment.Rto + rtoMin;
                }
                else if ((long)_current - sndSegment.ResendTs >= 0)
                {
                    needSend = true;
                    sndSegment.Xmit += 1;
                    if (!_nodelay)
                    {
                        sndSegment.Rto += _rxRto;
                    }
                    else
                    {
                        sndSegment.Rto += (uint)(_rxRto / 2);
                    }
                    sndSegment.ResendTs = _current + sndSegment.Rto;
                    lost = true;
                }
                else if (sndSegment.FastAck >= resent)
                {
                    needSend = true;
                    sndSegment.Xmit += 1;
                    sndSegment.FastAck = 0;
                    sndSegment.ResendTs = _current + sndSegment.Rto;
                    change += 1;
                }

                if (needSend)
                {
                    sndSegment.Ts = _current;
                    sndSegment.Wnd = segment.Wnd;
                    sndSegment.Una = _rcvNxt;

                    int need = KcpOverhead + sndSegment.Data.Length;

                    if (_bufOffset + need > _mtu)
                    {
                        OutputSlice();
                    }

                    _bufOffset += EncodeSegmentSlice(sndSegment);

                    if (sndSegment.Xmit >= _deadLink)
                    {
                        _state = -1;
                    }
                }
            }

            // Flush all data in buffer
            if (_bufOffset > 0)
            {
                OutputSlice();
            }

            // update ssthresh
            if (change > 0)
            {
                uint inflight = (uint)(_sndNxt - _sndUna);
                _ssThresh = (ushort)((inflight & 0xFFFF) / 2);
                if (_ssThresh < KcpThreshMin)
                {
                    _ssThresh = KcpThreshMin;
                }
                _cWnd = (ushort)(_ssThresh + (resent & 0xFFFF));
                _incr = _cWnd * _mss;
            }

            if (lost)
            {
                _ssThresh = (ushort)(cWnd / 2);
                if (_ssThresh < KcpThreshMin)
                {
                    _ssThresh = KcpThreshMin;
                }
                _cWnd = 1;
                _incr = _mss;
            }

            if (_cWnd < 1)
            {
                _cWnd = 1;
                _incr = _mss;
            }
        }

        /// <summary>
        /// 功能描述：将待发片段编码到共享缓冲区
        ///
        /// @param seg - KCP 段
        /// @returns 写入的字节数
        /// </summary>
        private int EncodeSegmentSlice(KcpSegment seg)
        {
            return EncodeSegment(_buf, seg); // 共享缓冲区足够大（(mtu+overhead)*3）
        }

        /// <summary>
        /// 功能描述：将共享缓冲区内容交给底层输出回调
        /// </summary>
        private void OutputSlice()
        {
            var slice = new byte[_bufOffset];
            Buffer.BlockCopy(_buf, 0, slice, 0, _bufOffset);
            _bufOffset = 0;
            _output(slice);
        }

        /// <summary>
        /// 功能描述：更新 KCP 状态（每 10ms ~ 100ms 调用一次）
        ///
        /// @param current - 当前时间（毫秒）
        /// </summary>
        public void Update(uint current)
        {
            _current = current;

            if (!_updated)
            {
                _updated = true;
                _tsFlush = _current;
            }

            long slap = (long)_current - _tsFlush;

            if (slap >= 10000 || slap < -10000)
            {
                _tsFlush = _current;
                slap = 0;
            }

            if (slap >= 0)
            {
                _tsFlush += _interval;
                if ((long)_current - _tsFlush >= 0)
                {
                    _tsFlush = _current + _interval;
                }
                Flush();
            }
        }

        /// <summary>
        /// 功能描述：计算下次应调用 update 的时间间隔（毫秒）
        ///
        /// @param current - 当前时间（毫秒）
        /// @returns 应等待的毫秒数
        /// </summary>
        public uint Check(uint current)
        {
            if (!_updated)
            {
                return 0;
            }

            uint tsFlush = _tsFlush;
            uint tmPacket = 0xffffffff;

            if ((long)current - tsFlush >= 10000 || (long)current - tsFlush < -10000)
            {
                tsFlush = current;
            }

            if ((long)current - tsFlush >= 0)
            {
                return 0;
            }

            uint tmFlush = (uint)((long)tsFlush - current);
            for (int i = 0; i < _sndBuf.Count; i++)
            {
                var seg = _sndBuf[i];
                long diff = (long)seg.ResendTs - current;
                if (diff <= 0)
                {
                    return 0;
                }
                if (diff < tmPacket)
                {
                    tmPacket = (uint)diff;
                }
            }

            return Math.Min(Math.Min(tmPacket, tmFlush), _interval);
        }

        /// <summary>
        /// 功能描述：设置 MTU 大小，默认 1400
        ///
        /// @param mtu - 最大传输单元
        /// </summary>
        public void SetMtu(int mtu)
        {
            mtu = Math.Max(mtu, Math.Max(50, KcpOverhead));
            _mtu = mtu;
            _mss = (uint)(mtu - KcpOverhead);
            _buf = new byte[(mtu + KcpOverhead) * 3];
        }

        /// <summary>
        /// 功能描述：获取 MTU
        /// </summary>
        public int GetMtu()
        {
            return _mtu;
        }

        /// <summary>
        /// 功能描述：设置检查间隔
        ///
        /// @param interval - 间隔毫秒数
        /// </summary>
        public void SetInterval(uint interval)
        {
            _interval = Math.Max(10, Math.Min(interval, 5000));
        }

        /// <summary>
        /// 功能描述：设置 nodelay
        ///
        /// 最快配置：nodelay(true, 20, 2, true)
        ///
        /// @param nodelay - 是否启用无延迟
        /// @param resend - 0 禁用快速重传，1 启用
        /// @param nc - true 禁用拥塞控制
        /// </summary>
        public void SetNodelay(bool nodelay, int resend, bool nc)
        {
            if (nodelay)
            {
                _nodelay = true;
                _rxMinRto = KcpRtoNdl;
            }
            else
            {
                _nodelay = false;
                _rxMinRto = KcpRtoMin;
            }
            _fastResend = (uint)Math.Max(0, resend);
            _nocwnd = nc;
        }

        /// <summary>
        /// 功能描述：设置窗口大小
        ///
        /// @param sndWnd - 发送窗口
        /// @param rcvWnd - 接收窗口
        /// </summary>
        public void SetWndSize(ushort sndWnd, ushort rcvWnd)
        {
            _sndWnd = (ushort)(sndWnd & 0xFFFF);
            _rcvWnd = Math.Max((ushort)(rcvWnd & 0xFFFF), KcpWndRcv);
        }

        /// <summary>
        /// 功能描述：获取发送窗口
        /// </summary>
        public ushort GetSndWnd()
        {
            return _sndWnd;
        }

        /// <summary>
        /// 功能描述：获取接收窗口
        /// </summary>
        public ushort GetRcvWnd()
        {
            return _rcvWnd;
        }

        /// <summary>
        /// 功能描述：获取待发送数据量（snd_buf + snd_queue）
        /// </summary>
        public int GetWaitSnd()
        {
            return _sndBuf.Count + _sndQueue.Count;
        }

        /// <summary>
        /// 功能描述：设置 rx_minrto
        ///
        /// @param rto - 最小重传超时
        /// </summary>
        public void SetRxMinRto(uint rto)
        {
            _rxMinRto = rto;
        }

        /// <summary>
        /// 功能描述：设置 fastresend
        ///
        /// @param fr - 快速重传阈值
        /// </summary>
        public void SetFastResend(uint fr)
        {
            _fastResend = fr;
        }

        /// <summary>
        /// 功能描述：获取 KCP 头部大小
        /// </summary>
        public int GetHeaderLen()
        {
            return KcpOverhead;
        }

        /// <summary>
        /// 功能描述：是否流模式
        /// </summary>
        public bool IsStream()
        {
            return _stream;
        }

        /// <summary>
        /// 功能描述：获取最大段大小
        /// </summary>
        public uint GetMss()
        {
            return _mss;
        }

        /// <summary>
        /// 功能描述：获取内部计算的平滑 RTT（毫秒）
        /// </summary>
        public uint GetRtt()
        {
            return _rxsRtt;
        }

        /// <summary>
        /// 功能描述：设置最大重传次数
        ///
        /// @param deadLink - 最大重传次数
        /// </summary>
        public void SetMaxResend(uint deadLink)
        {
            _deadLink = deadLink;
        }

        /// <summary>
        /// 功能描述：检查 KCP 连接是否已死亡（重传次数超限）
        /// </summary>
        public bool IsDeadLink()
        {
            return _state != 0;
        }

        private static void WriteUInt32LE(byte[] buf, int offset, uint value)
        {
            buf[offset] = (byte)(value & 0xFF);
            buf[offset + 1] = (byte)((value >> 8) & 0xFF);
            buf[offset + 2] = (byte)((value >> 16) & 0xFF);
            buf[offset + 3] = (byte)((value >> 24) & 0xFF);
        }

        private static uint ReadUInt32LE(byte[] buf, int offset)
        {
            return (uint)(buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24));
        }

        private static void WriteUInt16LE(byte[] buf, int offset, ushort value)
        {
            buf[offset] = (byte)(value & 0xFF);
            buf[offset + 1] = (byte)((value >> 8) & 0xFF);
        }

        private static ushort ReadUInt16LE(byte[] buf, int offset)
        {
            return (ushort)(buf[offset] | (buf[offset + 1] << 8));
        }
    }
}
