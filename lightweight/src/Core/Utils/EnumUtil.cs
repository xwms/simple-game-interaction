using System;
using System.Reflection;
using System.Runtime.Serialization;

namespace SGI
{
    /// <summary>
    /// 枚举工具：取回与 TS 字符串字面量一致的序列化值
    ///
    /// DTO 枚举通过 StringEnumConverter + EnumMember 序列化为 kebab-case 字符串；
    /// 日志场景需要同样的可读值，故提供本方法。
    /// </summary>
    internal static class EnumUtil
    {
        /// <summary>
        /// 功能描述：获取枚举的 EnumMember 序列化值
        ///
        /// @param value - 枚举值
        /// @returns 对应 TS 字符串字面量；未标注 EnumMember 时返回枚举名
        /// </summary>
        public static string ToApiString(Enum value)
        {
            if (value == null)
            {
                return "";
            }
            string name = value.ToString();
            var field = value.GetType().GetField(name);
            var attr = field?.GetCustomAttribute<EnumMemberAttribute>();
            return attr?.Value ?? name;
        }

        /// <summary>
        /// 功能描述：将 kebab-case 字符串反解析为枚举值
        ///
        /// 逻辑说明：遍历枚举字段的 EnumMember 特性，匹配序列化值（大小写不敏感）。
        ///           匹配失败时退回枚举名解析，仍失败返回 default(T)。
        ///           用于中继信号（如 easy-nat / endpoint-independent）回填 DTO 枚举。
        ///
        /// @param value - 枚举序列化字符串
        /// @returns 对应枚举值；无法匹配时返回 default(T)
        /// </summary>
        public static T ParseApiString<T>(string value) where T : struct, Enum
        {
            if (string.IsNullOrEmpty(value))
            {
                return default(T);
            }
            foreach (var field in typeof(T).GetFields())
            {
                if (!field.IsStatic)
                {
                    continue;
                }
                var attr = field.GetCustomAttribute<EnumMemberAttribute>();
                if (attr != null && string.Equals(attr.Value, value, StringComparison.OrdinalIgnoreCase))
                {
                    return (T)field.GetValue(null);
                }
            }
            if (Enum.TryParse(value, true, out T parsed))
            {
                return parsed;
            }
            return default(T);
        }
    }
}
