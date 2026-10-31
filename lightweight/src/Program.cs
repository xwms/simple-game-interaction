using System;
using System.Threading;
using System.Windows.Forms;

namespace SGI
{
    /// <summary>
    /// 程序入口：单实例锁 → 环境初始化 → 启动主窗口
    /// </summary>
    internal static class Program
    {
        /// <summary>
        /// 功能描述：程序入口
        ///
        /// 逻辑说明：用命名 Mutex 保证单实例（二次启动提示并退出）；
        ///           初始化目录与原生 DLL 后启动 WinForms 消息循环。
        /// </summary>
        [STAThread]
        private static void Main()
        {
            bool createdNew;
            using (var mutex = new Mutex(true, "SGI-Lightweight-SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show("SGI 已经在运行中。", "SGI", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }

                try
                {
                    Env.Init();
                    Updater.CleanOldExe();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("初始化失败：" + ex.Message, "SGI", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                // 静默检查更新（延迟 3 秒后台执行，不阻塞启动）
                Updater.InitAsync();

                Application.Run(new MainForm());
            }
        }
    }
}
