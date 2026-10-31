using System;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// 事件总线：C# 侧向渲染进程推送事件（对应 Electron 主进程 webContents.send）
    ///
    /// 消息格式与渲染层 shim 约定一致：{ channel, args }，args 为参数数组。
    /// </summary>
    internal static class EventBus
    {
        private static Action<string> _postJson;

        /// <summary>
        /// 功能描述：绑定事件推送回调（由 MainForm 在 WebView2 初始化完成后调用）
        ///
        /// @param postJson - 接收 JSON 字符串并推送给渲染进程的回调（CoreWebView2.PostWebMessageAsJson）
        /// </summary>
        public static void Attach(Action<string> postJson)
        {
            _postJson = postJson;
        }

        /// <summary>
        /// 功能描述：向渲染进程推送一个事件
        ///
        /// @param channel - 事件通道名（与渲染层 on(channel) 对应）
        /// @param args - 事件参数（按位置透传给渲染层回调）
        /// </summary>
        public static void Push(string channel, params object[] args)
        {
            var post = _postJson;
            if (post == null)
            {
                return;
            }
            var payload = new JObject
            {
                ["channel"] = channel,
                ["args"] = JToken.FromObject(args)
            };
            post(payload.ToString(Formatting.None));
        }
    }
}
