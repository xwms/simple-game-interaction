using System;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// IPC 桥：解析 WebView2 的 postMessage 消息，分发到 IpcHandlers 并异步回传响应
    ///
    /// 消息约定（与渲染层 lite-shim.ts 一致）：
    ///   - invoke 请求：{ id, channel, args } → 响应 { id, success, data|error }
    ///   - 命令（无 id）：{ channel }           → 例如 window:drag-start，无需响应
    /// </summary>
    internal class IpcBridge
    {
        private readonly MainForm _mainForm;
        private readonly IpcHandlers _handlers;

        public IpcBridge(MainForm mainForm)
        {
            _mainForm = mainForm;
            _handlers = new IpcHandlers(mainForm);
        }

        /// <summary>
        /// 功能描述：解析并分发一条来自渲染进程的消息
        ///
        /// 逻辑说明：JSON 解析失败静默忽略；有 id 视为 invoke，异步处理后回传响应；
        ///           无 id 视为命令，直接处理。
        ///
        /// @param json - WebView2 收到的 JSON 字符串
        /// </summary>
        public void HandleMessage(string json)
        {
            JObject msg;
            try
            {
                msg = JObject.Parse(json);
            }
            catch
            {
                return;
            }

            if (msg["id"] != null)
            {
                HandleInvoke(msg);
            }
            else
            {
                HandleCommand(msg);
            }
        }

        /// <summary>
        /// 功能描述：处理 invoke 请求并异步回传响应
        ///
        /// 逻辑说明：从消息取 id/channel/args，调用 IpcHandlers 分发，异常捕获后
        ///           统一返回 { success:false, error }，最后补回 id 推给渲染进程。
        ///
        /// @param msg - 已解析的 invoke 请求消息
        /// </summary>
        private async void HandleInvoke(JObject msg)
        {
            long id = msg["id"].Value<long>();
            string channel = msg["channel"]?.Value<string>();
            var args = msg["args"] as JArray ?? new JArray();

            JObject response;
            try
            {
                response = await _handlers.DispatchAsync(channel, args);
            }
            catch (Exception ex)
            {
                Log.Error($"IPC {channel} 处理异常: {ex}");
                response = new JObject
                {
                    ["success"] = false,
                    ["error"] = ex.Message
                };
            }

            response["id"] = id;
            PostJson(response);
        }

        /// <summary>
        /// 功能描述：处理无 id 的命令消息（fire-and-forget）
        ///
        /// @param msg - 已解析的命令消息
        /// </summary>
        private void HandleCommand(JObject msg)
        {
            string channel = msg["channel"]?.Value<string>();
            switch (channel)
            {
                case "window:drag-start":
                    Log.Info("[drag] window:drag-start received");
                    _mainForm.StartWindowDrag();
                    break;
            }
        }

        /// <summary>
        /// 功能描述：向渲染进程回传一条 JSON 消息
        ///
        /// @param obj - 要推送的响应对象
        /// </summary>
        private void PostJson(JObject obj)
        {
            _mainForm.PostToWebView(obj.ToString(Newtonsoft.Json.Formatting.None));
        }
    }
}
