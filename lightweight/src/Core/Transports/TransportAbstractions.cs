using System;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// 传输层统一抽象：IPv6 / P2P / Relay 三种传输均实现此接口
    ///
    /// 对应 src/core/transports/types.ts 的 C# 移植。
    /// 消费者（TunnelManager）通过此接口无感切换传输方式。
    /// </summary>
    internal static class TransportEvents
    {
        public const string Data = "data";
        public const string Status = "status";
        public const string Error = "error";
        public const string Close = "close";
        public const string Traffic = "traffic";
        public const string Reset = "reset";
        public const string Latency = "latency";
    }

    /// <summary>传输层常量</summary>
    internal static class TransportConstants
    {
        /// <summary>连接超时（默认 5 秒）</summary>
        public const int TimeoutMs = 5000;
    }

    /// <summary>
    /// 传输层统一接口
    ///
    /// 通过 C# 事件发射 Data/StatusChanged/Error/Close/Traffic/Reset/Latency。
    /// ConnectAsync / DisconnectAsync 管理生命周期，SendAsync 发送数据到对端。
    /// </summary>
    internal interface ITransport
    {
        /// <summary>传输类型（ipv6/p2p/relay）</summary>
        string Type { get; }

        /// <summary>当前状态</summary>
        TransportStatus Status { get; }

        /// <summary>收到对端数据</summary>
        event Action<byte[]> Data;
        /// <summary>状态变更</summary>
        event Action<TransportStatus> StatusChanged;
        /// <summary>错误</summary>
        event Action<Exception> Error;
        /// <summary>关闭</summary>
        event Action Close;
        /// <summary>流量统计</summary>
        event Action<TrafficSnapshot> Traffic;
        /// <summary>重置信号（通知重建游戏连接）</summary>
        event Action Reset;
        /// <summary>延迟测量</summary>
        event Action<long> Latency;

        /// <summary>
        /// 功能描述：连接到对端
        ///
        /// @param peerInfo - 对端连接信息
        /// @throws 连接超时或失败时抛出
        /// </summary>
        Task ConnectAsync(PeerConnectionInfo peerInfo);

        /// <summary>
        /// 功能描述：断开连接
        /// </summary>
        Task DisconnectAsync();

        /// <summary>
        /// 功能描述：发送数据到对端
        ///
        /// @param data - 二进制数据
        /// @throws 未连接时抛出
        /// </summary>
        Task SendAsync(byte[] data);
    }
}
