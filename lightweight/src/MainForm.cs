using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SGI
{
    /// <summary>
    /// 主窗口：无边框 WinForms 窗体承载 WebView2 加载 Vue SPA
    ///
    /// 与 Electron 版一致：900x600 无边框，关闭即退出，无托盘。
    /// 渲染层 NavBar 通过 IPC 触发最小化/关闭，drag 区通过 window:drag-start 命令触发拖拽。
    /// </summary>
    internal class MainForm : Form
    {
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int widthEllipse, int heightEllipse);

        [DllImport("user32.dll")]
        private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);

        private readonly WebView2 _webView = new WebView2();
        private readonly IpcBridge _bridge;

        public MainForm()
        {
            _bridge = new IpcBridge(this);
            InitWindow();
            Load += OnLoad;
            FormClosed += (s, e) => _webView.Dispose();
        }

        /// <summary>暴露给 IPC 桥/事件总线的 CoreWebView2 实例（未初始化时为 null）</summary>
        public CoreWebView2 CoreWebView2 => _webView.CoreWebView2;

        /// <summary>
        /// 功能描述：初始化窗口样式并挂载 WebView2 控件
        /// </summary>
        private void InitWindow()
        {
            FormBorderStyle = FormBorderStyle.None;
            ClientSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            Text = "SGI";

            // 加载完成前保持透明，OnLoad 中 NavigationCompleted 后再恢复可见，
            // 避免启动瞬间的白/黑/闪白闪烁序列
            Opacity = 0;
            // SPA 的 html/body 背景透明，显式置白作为兜底，避免透明区域透出黑色
            BackColor = Color.White;
            _webView.DefaultBackgroundColor = Color.White;
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);
        }

        /// <summary>
        /// 功能描述：窗体加载后初始化 WebView2 并加载 SPA
        ///
        /// 逻辑说明：解压内嵌 SPA → 创建 WebView2 环境 → 映射虚拟域名 app.local →
        ///           绑定消息接收与事件推送 → 导航到 index.html。
        /// </summary>
        private async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                ApplyRoundedCorners();
                string spaDir = EnsureSpaExtracted();
                var env = await CoreWebView2Environment.CreateAsync(null, Env.WebView2UserDataDir);
                await _webView.EnsureCoreWebView2Async(env);

                var core = _webView.CoreWebView2;
                core.SetVirtualHostNameToFolderMapping(
                    Env.VirtualHost, spaDir, CoreWebView2HostResourceAccessKind.Allow);
                core.WebMessageReceived += OnWebMessageReceived;
                EventBus.Attach(json => PostToWebView(json));
                core.Navigate($"https://{Env.VirtualHost}/index.html");

                // SPA 加载完成（含失败）后恢复窗口可见；5 秒兜底保证不卡在不可见状态
                core.NavigationCompleted += (s, args) => ShowWindowWhenReady();
                _ = Task.Delay(5000).ContinueWith(
                    _ => { try { BeginInvoke((Action)(() => Opacity = 1)); } catch { } },
                    TaskScheduler.Default);
            }
            catch (Exception ex)
            {
                Log.Error($"WebView2 初始化失败: {ex}");
                MessageBox.Show(
                    "无法初始化 WebView2：" + ex.Message +
                    "\n\n请确认系统已安装 Microsoft Edge WebView2 运行时（Windows 11 自带）。",
                    "SGI", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        /// <summary>
        /// 功能描述：处理渲染进程通过 postMessage 发来的消息
        ///
        /// @param sender - 事件源
        /// @param e - 消息事件，WebMessageAsJson 为 JSON 字符串
        /// </summary>
        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            _bridge.HandleMessage(e.WebMessageAsJson);
        }

        /// <summary>
        /// 功能描述：从内嵌资源解压 SPA 到 userData/web/&lt;版本号&gt;
        ///
        /// 逻辑说明：按版本号分目录，版本变化时重新解压，避免旧缓存。
        ///           net48 无覆盖解压重载，故先删除目标目录再解压。
        ///
        /// @returns SPA 根目录路径
        /// </summary>
        private string EnsureSpaExtracted()
        {
            string targetDir = Path.Combine(Env.WebDir, Env.Version);
            if (Directory.Exists(targetDir) && File.Exists(Path.Combine(targetDir, "index.html")))
            {
                return targetDir;
            }

            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("SGI.Resources.SPA.zip"))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("未找到内嵌的 SPA.zip 资源（需先运行 build.mjs）");
                }
                if (Directory.Exists(targetDir))
                {
                    Directory.Delete(targetDir, true);
                }
                Directory.CreateDirectory(targetDir);
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    zip.ExtractToDirectory(targetDir);
                }
            }
            return targetDir;
        }

        /// <summary>
        /// 功能描述：向 WebView2 推送一条 JSON 消息（线程安全）
        ///
        /// 逻辑说明：PostWebMessageAsJson 只能在 UI 线程调用，后台线程触发
        ///           （Timer 回调、async 延续）时先编组到 UI 线程再发送。
        /// </summary>
        /// <param name="json">要推送的 JSON 字符串</param>
        public void PostToWebView(string json)
        {
            // 必须先判线程再访问 CoreWebView2：COM 对象仅能在 UI 线程访问，后台线程直接取值即抛异常
            if (InvokeRequired)
            {
                try
                {
                    BeginInvoke(new Action<string>(PostToWebView), json);
                }
                catch
                {
                    // 窗口关闭中，忽略
                }
                return;
            }
            var core = _webView.CoreWebView2;
            if (core == null)
            {
                return;
            }
            try
            {
                core.PostWebMessageAsJson(json);
            }
            catch
            {
                // 推送失败不影响主流程
            }
        }

        /// <summary>
        /// 功能描述：将窗口裁剪为圆角
        ///
        /// 逻辑说明：无边框窗体默认直角。DwmSetWindowAttribute 的 DWMWA_WINDOW_CORNER_PREFERENCE
        ///           在无边框窗体上实测不生效（读回为 0），改用窗口区域 SetWindowRgn 强制裁剪。
        ///           区域会同时裁剪子窗口（WebView2），杜绝四角露出方形底色。
        /// </summary>
        private void ApplyRoundedCorners()
        {
            IntPtr hRgn = CreateRoundRectRgn(0, 0, ClientSize.Width + 1, ClientSize.Height + 1, 24, 24);
            SetWindowRgn(Handle, hRgn, true);
        }

        /// <summary>
        /// 功能描述：SPA 加载完成后恢复窗口可见
        ///
        /// 逻辑说明：InitWindow 中 Opacity 置 0 隐藏启动闪烁，此处恢复。NavigationCompleted
        ///           在加载成功与失败时都会触发，故可作为唯一显示时机。
        /// </summary>
        private void ShowWindowWhenReady()
        {
            Opacity = 1;
        }

        /// <summary>
        /// 功能描述：启动窗口拖拽（渲染层 drag 区 mousedown 时触发）
        ///
        /// 逻辑说明：标准无边框窗口拖拽手法：ReleaseCapture 后向窗口发送
        ///           WM_NCLBUTTONDOWN + HTCAPTION，让系统接管标题栏拖拽逻辑。
        /// </summary>
        public void StartWindowDrag()
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
        }

        /// <summary>
        /// 功能描述：最小化窗口（渲染层 NavBar 最小化按钮触发）
        /// </summary>
        public void MinimizeWindow()
        {
            WindowState = FormWindowState.Minimized;
        }

        /// <summary>
        /// 功能描述：关闭窗口（渲染层 NavBar 关闭按钮触发，关闭即退出）
        /// </summary>
        public void CloseWindow()
        {
            Close();
        }

        /// <summary>
        /// 功能描述：弹出目录选择对话框选择日志目录
        ///
        /// 逻辑说明：FolderBrowserDialog 必须在 UI 线程创建，IPC 处理器在后台线程调用
        ///           时先 Invoke 编组到 UI 线程；取消返回 null。
        ///
        /// @returns 选中的目录路径，取消时为 null
        /// </summary>
        public string SelectLogDirectory()
        {
            if (InvokeRequired)
            {
                return (string)Invoke(new Func<string>(SelectLogDirectory));
            }
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择日志文件目录";
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    return dialog.SelectedPath;
                }
            }
            return null;
        }
    }
}
