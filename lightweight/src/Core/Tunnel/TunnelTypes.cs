using System.Collections.Generic;

namespace SGI
{
    /// <summary>
    /// 隧道模块类型定义：Relay 配置、协议消息类型常量
    ///
    /// 对应 src/core/tunnel/types.ts 的 C# 移植。
    /// 中继消息遵循 JSON 文本帧 + 二进制数据帧的双通道协议。
    /// </summary>

    /// <summary>Relay 客户端配置</summary>
    public class RelayConfig
    {
        public string RelayUrl = "ws://159.75.150.37:9800";
        /// <summary>最大重连次数</summary>
        public int ReconnectMaxAttempts = 5;
        /// <summary>重连基础延迟（毫秒，指数退避）</summary>
        public int ReconnectBaseDelay = 1000;
        /// <summary>心跳发送间隔（毫秒）</summary>
        public int HeartbeatInterval = 10000;
        /// <summary>心跳超时阈值（毫秒，需 >= HeartbeatInterval * 2）</summary>
        public int HeartbeatTimeout = 30000;
        /// <summary>连接超时（毫秒）</summary>
        public int ConnectTimeout = 5000;
    }

    /// <summary>Relay 协议消息类型常量</summary>
    public static class RelayMessageTypes
    {
        public const string CreateRoom = "create-room";
        public const string RoomCreated = "room-created";
        public const string JoinRoom = "join-room";
        public const string RoomJoined = "room-joined";
        public const string LeaveRoom = "leave-room";
        public const string MemberJoined = "member-joined";
        public const string MemberLeft = "member-left";
        public const string RoomClosed = "room-closed";
        public const string RelayData = "relay-data";
        public const string Signal = "signal";
        public const string Heartbeat = "heartbeat";
        public const string Error = "error";
    }

    /// <summary>创建房间参数</summary>
    public class CreateRoomParams
    {
        public string GameId;
        public string GameName;
        public int GamePort;
        public string MemberName;
        public NetworkInfo NetworkInfo;
    }

    /// <summary>创建房间结果</summary>
    public class CreateRoomResult
    {
        public string RoomCode;
        public string MemberId;
    }

    /// <summary>加入房间参数</summary>
    public class JoinRoomParams
    {
        public string MemberName;
        public NetworkInfo NetworkInfo;
    }

    /// <summary>加入房间结果（中继服务器命名：serverId/serverNetworkInfo）</summary>
    public class TunnelJoinRoomResult
    {
        public string RoomCode;
        public string MemberId;
        public string ServerId;
        public NetworkInfo ServerNetworkInfo;
        public int GamePort;
        public List<MemberInfo> Members = new List<MemberInfo>();
    }

    /// <summary>成员信息消息</summary>
    public class MemberJoinedData
    {
        public string MemberId;
        public string MemberName;
        public NetworkInfo NetworkInfo;
    }

    /// <summary>Relay 消息基类</summary>
    public class RelayMessage
    {
        public string Type;
        public string MessageId;
        public object Data;
        public RelayError Error;
    }

    /// <summary>Relay 错误结构</summary>
    public class RelayError
    {
        public string Code;
        public string Message;
    }

    /// <summary>二进制数据帧头部字节数</summary>
    public static class RelayConstants
    {
        public const int BinaryFrameHeaderSize = 4;
    }
}
