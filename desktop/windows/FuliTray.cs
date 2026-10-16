using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Windows shell only. The bundled JS controller owns runtime commands and
// status interpretation; this process never terminates database processes.
internal static class FuliTray
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 0) throw new Exception("此候选从 tray-config.json 读取目录，不接受命令行参数。 / This candidate reads tray-config.json and accepts no arguments.");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var runner = new ControllerRunner(AppDomain.CurrentDomain.BaseDirectory);
            var selected = runner.Run("context");
            if (!selected.ok) throw new Exception(selected.error);
            var name = "Global\\FuliTray-" + WindowsIdentity.GetCurrent().User.Value + "-" + selected.instanceKey;
            using (var mutex = new Mutex(false, name))
            {
                bool owned;
                try { owned = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned)
                {
                    // Hand the request to the existing UI thread. Running a
                    // second CLI here would bypass its serialized operations.
                    for (int attempt = 0; attempt < 40; attempt++)
                    {
                        try
                        {
                            using (var signal = EventWaitHandle.OpenExisting(name + "-open")) signal.Set();
                            return 0;
                        }
                        catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(50); }
                    }
                    throw new Exception("托盘正在启动，请稍后重试。 / The tray is starting; please try again shortly.");
                }
                try
                {
                    using (var signal = new EventWaitHandle(false, EventResetMode.AutoReset, name + "-open"))
                    using (var tray = new TrayContext(runner, selected, signal)) Application.Run(tray);
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Fuli 托盘 / Fuli tray", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private sealed class TrayContext : ApplicationContext
    {
        private readonly ControllerRunner runner;
        private readonly ControllerReply selected;
        private readonly NotifyIcon icon;
        private readonly Icon image;
        private readonly ContextMenuStrip menu = new ContextMenuStrip();
        private readonly ToolStripMenuItem state = new ToolStripMenuItem("正在检查 / Checking status");
        private readonly ToolStripMenuItem operation = new ToolStripMenuItem();
        private readonly Control dispatch = new Control();
        private readonly System.Windows.Forms.Timer refresh = new System.Windows.Forms.Timer();
        private readonly RegisteredWaitHandle openWait;
        private bool busy;
        private volatile bool exiting;

        public TrayContext(ControllerRunner runner, ControllerReply selected, EventWaitHandle signal)
        {
            this.runner = runner;
            this.selected = selected;
            var handle = dispatch.Handle;
            state.Enabled = false;
            operation.Enabled = false;
            operation.Visible = false;
            menu.Items.Add(state);
            menu.Items.Add(operation);
            menu.Items.Add(new ToolStripSeparator());
            AddAction("启动并打开 Fuli / Start and open", "start-open");
            AddAction("仅打开管理页 / Open running console", "open");
            AddAction("停止 Fuli 服务 / Stop services", "stop");
            AddAction("刷新状态 / Refresh status", "status");
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开日志目录 / Open logs", null, delegate { OpenDirectory(selected.logDir); });
            menu.Items.Add("打开数据目录 / Open data folder", null, delegate { OpenDirectory(selected.dataDir); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出托盘（Fuli 继续运行）/ Exit tray, keep services", null,
                delegate { if (!busy) ExitThread(); });
            AddAction("停止 Fuli 并退出 / Stop services and exit", "stop-exit");

            image = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon = new NotifyIcon { Icon = image, Text = "Fuli — 正在检查 / Checking", ContextMenuStrip = menu, Visible = true };
            icon.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) RunAction("start-open", true);
            };
            openWait = ThreadPool.RegisterWaitForSingleObject(signal,
                delegate { Post(delegate { RunAction("start-open", true); }); }, null, Timeout.Infinite, false);
            refresh.Interval = 30000;
            refresh.Tick += delegate { if (!busy) RunAction("status", false); };
            refresh.Start();
            RunAction("status", false);
        }

        private void AddAction(string title, string action)
        {
            menu.Items.Add(title, null, delegate { RunAction(action, true); });
        }

        private void RunAction(string action, bool showErrors)
        {
            if (exiting) return;
            if (busy)
            {
                if (showErrors) icon.ShowBalloonTip(3000, "Fuli", "操作进行中，请稍后重试。 / An operation is in progress; please try again shortly.", ToolTipIcon.Info);
                return;
            }
            busy = true;
            foreach (ToolStripItem item in menu.Items)
                if (item is ToolStripMenuItem && item != state && item != operation) item.Enabled = false;
            var command = action == "stop-exit" ? "stop" : action;
            operation.Text = command == "status" ? "正在读取服务状态 / Reading service status"
                : command == "stop" ? "正在停止 Fuli 服务 / Stopping Fuli services"
                : command == "open" ? "正在打开管理页 / Opening console"
                : "正在启动并打开 Fuli / Starting and opening Fuli";
            operation.Visible = true;
            Task.Run(delegate
            {
                ControllerReply reply;
                try { reply = runner.Run(command); }
                catch (Exception error) { reply = new ControllerReply { ok = false, error = error.Message }; }
                Post(delegate
                {
                    busy = false;
                    operation.Visible = false;
                    foreach (ToolStripItem item in menu.Items)
                        if (item is ToolStripMenuItem && item != state && item != operation) item.Enabled = true;
                    state.Text = reply.label ?? "状态未知 / Unknown";
                    var tip = "Fuli — " + state.Text;
                    icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
                    if (!reply.ok && showErrors)
                    {
                        MessageBox.Show(dispatch, (reply.error ?? "服务操作失败 / The service operation failed")
                            + "\n\n数据目录 / Data: " + selected.dataDir
                            + "\n日志 / Logs: " + selected.logDir
                            + "\nNative 日志 / Native logs: " + selected.nativeLogDir,
                            "Fuli", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    // Failed or partial stops keep the tray and its diagnostic
                    // state visible. Closing the browser never stops services.
                    if (reply.ok && action == "stop-exit") ExitThread();
                });
            });
        }

        private void OpenDirectory(string path)
        {
            if (!Directory.Exists(path))
            {
                MessageBox.Show(dispatch, "目录尚未创建 / Directory not created yet:\n" + path, "Fuli");
                return;
            }
            try { Process.Start(new ProcessStartInfo { FileName = path, UseShellExecute = true }); }
            catch (Exception error) { MessageBox.Show(dispatch, error.Message, "Fuli"); }
        }

        private void Post(Action action)
        {
            if (exiting) return;
            try { dispatch.BeginInvoke(new Action(delegate { if (!exiting) action(); })); }
            catch (InvalidOperationException) { /* The shell is already closing. */ }
        }

        protected override void ExitThreadCore()
        {
            exiting = true;
            refresh.Stop();
            icon.Visible = false;
            base.ExitThreadCore();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                exiting = true;
                openWait.Unregister(null);
                refresh.Dispose();
                icon.Dispose();
                image.Dispose();
                menu.Dispose();
                dispatch.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    private sealed class ControllerRunner
    {
        private readonly string root;
        public ControllerRunner(string root) { this.root = root; }

        public ControllerReply Run(string action)
        {
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(root, "runtime", "node", "node.exe"),
                Arguments = Quote(Path.Combine(root, "src", "desktop", "windows-controller.js")) + " " + action,
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            using (var child = Process.Start(start))
            {
                var output = child.StandardOutput.ReadToEndAsync();
                var error = child.StandardError.ReadToEndAsync();
                child.WaitForExit();
                var json = output.Result.Trim();
                if (json.Length == 0) throw new Exception("JS 控制器未返回状态 / No controller result. " + error.Result);
                var reply = new JavaScriptSerializer().Deserialize<ControllerReply>(json);
                if (reply == null) throw new Exception("JS 控制器状态无效 / Invalid controller result.");
                if (child.ExitCode != 0) reply.ok = false;
                return reply;
            }
        }

        private static string Quote(string value)
        {
            // The script is a resolved file path (cannot contain a quote and
            // never ends in a slash), not shell text or an arbitrary argument.
            return "\"" + value + "\"";
        }
    }

    public sealed class ControllerReply
    {
        public bool ok { get; set; }
        public string error { get; set; }
        public string label { get; set; }
        public string dataDir { get; set; }
        public string logDir { get; set; }
        public string nativeLogDir { get; set; }
        public string instanceKey { get; set; }
    }
}
