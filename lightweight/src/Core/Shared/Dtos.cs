using System.Collections.Generic;
using System.Runtime.Serialization;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace SGI
{
    // ─── 枚举（对应 src/shared/types.ts 的字符串联合类型）────

    /// <summary>
    /// NAT 类型（对应 TS NatType）
    ///
    /// none=公网直连、easy-nat=Endpoint-Independent 映射、
    /// hard-nat=地址相关映射、unknown=未检测到。
    /// </summary>
    [JsonConverter(typeof(StringEnumConverter))]
    public enum NatType
    {
        [EnumMember(Value = "none")] None,
        [EnumMember(Value = "easy-nat")] EasyNat,
        [EnumMember(Value = "hard-nat")] HardNat,
        [EnumMember(Value = "unknown")] Unknown
    }

    /// <summary>
    /// 映射行为 (RFC 5780 Mapping Behavior)
    ///
    /// EndpointIndependent: 对任意目的地址复用同一映射端口（Cone NAT）
    /// AddressDependent: 不同目的 IP 使用不同映射端口
    /// AddressAndPortDependent: 不同目的 IP:端口 使用不同映射端口（Symmetric NAT）
    /// </summary>
    [JsonConverter(typeof(StringEnumConverter))]
    public enum MappingBehavior
    {
        [EnumMember(Value = "endpoint-independent")] EndpointIndependent,
        [EnumMember(Value = "address-dependent")] AddressDependent,
        [EnumMember(Value = "address-and-port-dependent")] AddressAndPortDependent,
        [EnumMember(Value = "unknown")] Unknown
    }

    /// <summary>
    /// 过滤行为 (RFC 5780 Filtering Behavior)
    ///
    /// EndpointIndependent: 任意外部主机均可向映射地址发包（Full Cone）
    /// AddressDependent: 仅本机曾联系过的 IP 可发回（Restricted Cone）
    /// AddressAndPortDependent: 仅本机曾联系过的精确 IP:端口 可发回（Port Restricted Cone）
    /// </summary>
    [JsonConverter(typeof(StringEnumConverter))]
    public enum FilteringBehavior
    {
        [EnumMember(Value = "endpoint-independent")] EndpointIndependent,
        [EnumMember(Value = "address-dependent")] AddressDependent,
        [EnumMember(Value = "address-and-port-dependent")] AddressAndPortDependent,
        [EnumMember(Value = "unknown")] Unknown
    }

    // ─── 网络检测 DTO（模块内部，不直接序列化）────

    /// <summary>IPv6 检测结果（对应 src/core/network/types.ts Ipv6CheckResult）</summary>
    public class Ipv6CheckResult
    {
        /// <summary>是否具备 IPv6 外网可达性</summary>
        public bool Available { get; set; }

        /// <summary>是否存在公网 IPv6 地址</summary>
        public bool HasPublicV6 { get; set; }

        /// <summary>本机全部 IPv6 地址</summary>
        public List<string> Addresses { get; set; } = new List<string>();

        /// <summary>公网 IPv6 地址列表</summary>
        public List<string> PublicAddresses { get; set; } = new List<string>();
    }

    /// <summary>NAT 检测结果（对应 src/core/network/types.ts NatCheckResult）</summary>
    public class NatCheckResult
    {
        public NatType NatType { get; set; } = NatType.Unknown;
        public MappingBehavior MappingBehavior { get; set; } = MappingBehavior.Unknown;
        public FilteringBehavior FilteringBehavior { get; set; } = FilteringBehavior.Unknown;
        public string PublicIp { get; set; } = "";
        public int PublicPort { get; set; }
        public List<string> LocalAddresses { get; set; } = new List<string>();
    }

    // ─── 对外 NetworkInfo（序列化到渲染进程，字段名与 TS 对齐）────

    /// <summary>标准网络信息（对应 src/shared/types.ts NetworkInfo）</summary>
    public class NetworkInfo
    {
        [JsonProperty("ipv6")]
        public Ipv6Info Ipv6 { get; set; }

        [JsonProperty("ipv4")]
        public Ipv4Info Ipv4 { get; set; }
    }

    /// <summary>IPv6 部分</summary>
    public class Ipv6Info
    {
        [JsonProperty("available")]
        public bool Available { get; set; }

        [JsonProperty("hasPublicV6")]
        public bool HasPublicV6 { get; set; }

        [JsonProperty("addresses")]
        public List<string> Addresses { get; set; } = new List<string>();
    }

    /// <summary>IPv4/NAT 部分</summary>
    public class Ipv4Info
    {
        [JsonProperty("natType")]
        public NatType NatType { get; set; }

        [JsonProperty("publicIp")]
        public string PublicIp { get; set; } = "";

        [JsonProperty("publicPort")]
        public int PublicPort { get; set; }

        [JsonProperty("mappingBehavior")]
        public MappingBehavior MappingBehavior { get; set; }

        [JsonProperty("filteringBehavior")]
        public FilteringBehavior FilteringBehavior { get; set; }

        [JsonProperty("localAddresses")]
        public List<string> LocalAddresses { get; set; } = new List<string>();
    }

    // ─── 游戏发现 DTO（对应 src/shared/types.ts）────

    /// <summary>游戏信息（协议：tcp/udp）</summary>
    public class GameInfo
    {
        [JsonProperty("id")] public string Id { get; set; } = "";
        [JsonProperty("name")] public string Name { get; set; } = "";
        [JsonProperty("port")] public int Port { get; set; }
        [JsonProperty("protocol")] public string Protocol { get; set; } = "tcp";
        [JsonProperty("host")] public string Host { get; set; } = "";
        [JsonProperty("status")] public string Status { get; set; }
    }

    /// <summary>游戏协议数据库条目</summary>
    public class GameProtocolEntry
    {
        [JsonProperty("id")] public string Id { get; set; } = "";
        [JsonProperty("name")] public string Name { get; set; } = "";
        [JsonProperty("processNames")] public List<string> ProcessNames { get; set; } = new List<string>();
        [JsonProperty("defaultPort")] public int DefaultPort { get; set; }
        [JsonProperty("protocol")] public string Protocol { get; set; } = "tcp";
        [JsonProperty("altPorts")] public List<int> AltPorts { get; set; } = new List<int>();
        [JsonProperty("sniffable")] public bool Sniffable { get; set; }
        [JsonProperty("description")] public string Description { get; set; }
    }

    /// <summary>LAN 扫描发现的游戏实例</summary>
    public class DiscoveredGame
    {
        [JsonProperty("id")] public string Id { get; set; } = "";
        [JsonProperty("gameId")] public string GameId { get; set; } = "";
        [JsonProperty("name")] public string Name { get; set; } = "";
        [JsonProperty("host")] public string Host { get; set; } = "";
        [JsonProperty("port")] public int Port { get; set; }
        [JsonProperty("protocol")] public string Protocol { get; set; } = "tcp";
        [JsonProperty("viaLan")] public bool ViaLan { get; set; }
        [JsonProperty("lastSeen")] public long LastSeen { get; set; }
        [JsonProperty("extra")] public Dictionary<string, string> Extra { get; set; }
    }

    /// <summary>LAN 扫描事件（type: discovered/updated/removed/error）</summary>
    public class ScanEvent
    {
        [JsonProperty("type")] public string Type { get; set; } = "";
        [JsonProperty("game")] public DiscoveredGame Game { get; set; }
        [JsonProperty("error")] public string Error { get; set; }
    }

    /// <summary>协议嗅探结果（模块内部）</summary>
    public class SniffResult
    {
        public bool Detected { get; set; }
        public string GameId { get; set; } = "";
        public string Host { get; set; } = "";
        public int Port { get; set; }
        public Dictionary<string, string> Extra { get; set; }
        public long LatencyMs { get; set; }
    }

    // ─── 连接/隧道 DTO（对应 src/shared/types.ts）────

    /// <summary>连接路径类型（ipv6/p2p/relay）</summary>
    [JsonConverter(typeof(StringEnumConverter))]
    public enum ConnectionPathType
    {
        [EnumMember(Value = "ipv6")] Ipv6,
        [EnumMember(Value = "p2p")] P2p,
        [EnumMember(Value = "relay")] Relay
    }

    /// <summary>隧道状态（disconnected/connecting/connected/error）</summary>
    [JsonConverter(typeof(StringEnumConverter))]
    public enum TransportStatus
    {
        [EnumMember(Value = "disconnected")] Disconnected,
        [EnumMember(Value = "connecting")] Connecting,
        [EnumMember(Value = "connected")] Connected,
        [EnumMember(Value = "error")] Error
    }

    /// <summary>IP:端口 端点</summary>
    public class EndpointInfo
    {
        [JsonProperty("ip")] public string Ip { get; set; } = "";
        [JsonProperty("port")] public int Port { get; set; }
    }

    /// <summary>对端连接信息（不同传输方式使用不同字段）</summary>
    public class PeerConnectionInfo
    {
        [JsonProperty("peerId")] public string PeerId { get; set; } = "";
        [JsonProperty("publicAddress")] public EndpointInfo PublicAddress { get; set; }
        [JsonProperty("localAddresses")] public List<EndpointInfo> LocalAddresses { get; set; }
        [JsonProperty("ipv6Address")] public string Ipv6Address { get; set; }
        [JsonProperty("ipv6Port")] public int Ipv6Port { get; set; }
        [JsonProperty("kcpAddress")] public EndpointInfo KcpAddress { get; set; }
    }

    /// <summary>流量快照</summary>
    public class TrafficSnapshot
    {
        [JsonProperty("bytesSent")] public long BytesSent { get; set; }
        [JsonProperty("bytesReceived")] public long BytesReceived { get; set; }
        [JsonProperty("timestamp")] public long Timestamp { get; set; }
    }

    /// <summary>连接路径（路径选择算法输出）</summary>
    public class ConnectionPath
    {
        [JsonProperty("type")] public ConnectionPathType Type { get; set; }
        [JsonProperty("priority")] public int Priority { get; set; }
        [JsonProperty("description")] public string Description { get; set; } = "";
        [JsonProperty("p2pStrategy")] public P2pStrategy P2pStrategy { get; set; }
    }

    /// <summary>P2P 连接策略（NAT 行为类型）</summary>
    public class P2pStrategy
    {
        [JsonProperty("server")] public NatBehavior Server { get; set; }
        [JsonProperty("client")] public NatBehavior Client { get; set; }
        [JsonProperty("methods")] public List<string> Methods { get; set; } = new List<string>();
    }

    /// <summary>NAT 行为（供 P2P 策略判定打洞方式）</summary>
    public class NatBehavior
    {
        [JsonProperty("mappingBehavior")] public MappingBehavior MappingBehavior { get; set; }
        [JsonProperty("filteringBehavior")] public FilteringBehavior FilteringBehavior { get; set; }
    }

    /// <summary>房间创建参数（渲染进程 → 主进程）</summary>
    public class CreateRoomOptions
    {
        [JsonProperty("gameId")] public string GameId { get; set; } = "";
        [JsonProperty("gameName")] public string GameName { get; set; } = "";
        [JsonProperty("gamePort")] public int GamePort { get; set; }
        [JsonProperty("relayUrl")] public string RelayUrl { get; set; }
    }

    /// <summary>加入房间结果（主进程 → 渲染进程）</summary>
    public class JoinRoomResult
    {
        [JsonProperty("roomCode")] public string RoomCode { get; set; } = "";
        [JsonProperty("memberId")] public string MemberId { get; set; } = "";
        [JsonProperty("hostId")] public string HostId { get; set; } = "";
        [JsonProperty("hostNetworkInfo")] public NetworkInfo HostNetworkInfo { get; set; }
        [JsonProperty("gamePort")] public int GamePort { get; set; }
        [JsonProperty("members")] public List<MemberInfo> Members { get; set; } = new List<MemberInfo>();
    }

    /// <summary>隧道启动参数</summary>
    public class TunnelStartOptions
    {
        [JsonProperty("port")] public int Port { get; set; }
        [JsonProperty("roomCode")] public string RoomCode { get; set; } = "";
    }

    /// <summary>隧道启动结果</summary>
    public class TunnelStartResult
    {
        [JsonProperty("port")] public int Port { get; set; }
        [JsonProperty("transport")] public ConnectionPathType Transport { get; set; }
    }

    /// <summary>房间成员</summary>
    public class MemberInfo
    {
        [JsonProperty("id")] public string Id { get; set; } = "";
        [JsonProperty("name")] public string Name { get; set; } = "";
        [JsonProperty("transport")] public ConnectionPathType? Transport { get; set; }
    }

    /// <summary>房间信息</summary>
    public class RoomInfo
    {
        [JsonProperty("roomCode")] public string RoomCode { get; set; } = "";
        [JsonProperty("hostId")] public string HostId { get; set; } = "";
        [JsonProperty("gameId")] public string GameId { get; set; } = "";
        [JsonProperty("gameName")] public string GameName { get; set; } = "";
        [JsonProperty("gamePort")] public int GamePort { get; set; }
        [JsonProperty("members")] public List<MemberInfo> Members { get; set; } = new List<MemberInfo>();
        [JsonProperty("createdAt")] public long CreatedAt { get; set; }
    }

    /// <summary>更新信息</summary>
    public class UpdateInfo
    {
        [JsonProperty("hasUpdate")] public bool HasUpdate { get; set; }
        [JsonProperty("version")] public string Version { get; set; } = "";
        [JsonProperty("releaseNotes")] public string ReleaseNotes { get; set; }
        [JsonProperty("downloadUrl")] public string DownloadUrl { get; set; }
        [JsonProperty("source")] public string Source { get; set; }
        [JsonProperty("downloadedBytes")] public long DownloadedBytes { get; set; }
        [JsonProperty("installAvailable")] public bool InstallAvailable { get; set; }
        [JsonProperty("installPath")] public string InstallPath { get; set; }
    }

    /// <summary>隧道状态报告</summary>
    public class TunnelStatusReport
    {
        [JsonProperty("state")] public string State { get; set; } = "";
        [JsonProperty("transportType")] public string TransportType { get; set; }
        [JsonProperty("localPort")] public int LocalPort { get; set; }
        [JsonProperty("clientCount")] public int ClientCount { get; set; }
        [JsonProperty("trafficBytesSent")] public long TrafficBytesSent { get; set; }
        [JsonProperty("trafficBytesReceived")] public long TrafficBytesReceived { get; set; }
    }

    /// <summary>连接建立事件（localPort/gamePort/roomCode）</summary>
    public class TunnelConnectedInfo
    {
        [JsonProperty("localPort")] public int LocalPort { get; set; }
        [JsonProperty("gamePort")] public int GamePort { get; set; }
        [JsonProperty("roomCode")] public string RoomCode { get; set; } = "";
    }

    // ─── 本地游戏检测 DTO（对应 src/shared/types.ts）────

    /// <summary>游戏检测结果（进程 + 端口）</summary>
    public class GameDetectResult
    {
        [JsonProperty("gameId")] public string GameId { get; set; } = "";
        [JsonProperty("name")] public string Name { get; set; } = "";
        [JsonProperty("running")] public bool Running { get; set; }
        [JsonProperty("portOpen")] public bool PortOpen { get; set; }
        [JsonProperty("port")] public int Port { get; set; }
        [JsonProperty("ports")] public List<int> Ports { get; set; } = new List<int>();
        [JsonProperty("pid")] public int? Pid { get; set; }
        [JsonProperty("processName")] public string ProcessName { get; set; }
    }

    /// <summary>进程信息（tasklist 解析）</summary>
    public class ProcessInfo
    {
        [JsonProperty("pid")] public int Pid { get; set; }
        [JsonProperty("name")] public string Name { get; set; } = "";
    }

    /// <summary>端口检测结果</summary>
    public class PortCheckResult
    {
        [JsonProperty("port")] public int Port { get; set; }
        [JsonProperty("protocol")] public string Protocol { get; set; } = "tcp";
        [JsonProperty("inUse")] public bool InUse { get; set; }
        [JsonProperty("pid")] public int? Pid { get; set; }
        [JsonProperty("processName")] public string ProcessName { get; set; }
    }
}
