using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// One deadline covers controller execution AND stdout/stderr EOF. Inherited
// pipe handles must not turn an otherwise exited process into an endless wait.
internal sealed class ControllerRunner
{
    private readonly string root;
    private readonly int timeoutMs;
    private readonly int cleanupMs;

    public ControllerRunner(string root, int timeoutMs = 180000, int cleanupMs = 3000)
    {
        if (timeoutMs <= 0 || cleanupMs <= 0) throw new ArgumentOutOfRangeException("timeoutMs");
        this.root = root; this.timeoutMs = timeoutMs; this.cleanupMs = cleanupMs;
    }

    public ControllerReply Run(string action)
    {
        var clock = Stopwatch.StartNew();
        var limit = action == "context" ? Math.Min(timeoutMs, 15000) : timeoutMs;
        var start = new ProcessStartInfo
        {
            FileName = Path.Combine(root, "runtime", "node", "node.exe"),
            // A resolved script filename cannot contain quotes or end in a slash.
            Arguments = "\"" + Path.Combine(root, "src", "desktop", "windows-controller.js") + "\" " + action,
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        using (var child = Process.Start(start))
        using (var stdout = child.StandardOutput)
        using (var stderr = child.StandardError)
        {
            // Hold the original handle throughout cleanup; never terminate a
            // subsequently reused PID. Child CLI handles get the same treatment.
            var handle = child.Handle;
            // Query before waiting: Windows may no longer return the image
            // name after the controller exits while descendants hold its pipes.
            var image = ImagePath(handle) ?? Path.GetFullPath(start.FileName);
            try
            {
              using (var output = new PipeCapture(stdout.BaseStream))
              using (var error = new PipeCapture(stderr.BaseStream))
              {
                while (clock.ElapsedMilliseconds < limit)
                {
                    output.Drain(); error.Drain();
                    if (child.WaitForExit(0) && output.Ended && error.Ended)
                    {
                        var json = output.Text.Trim();
                        if (json.Length == 0) throw new IOException("JS 控制器未返回状态 / No controller result. " + error.Text);
                        var reply = new JavaScriptSerializer().Deserialize<ControllerReply>(json);
                        if (reply == null) throw new IOException("JS 控制器状态无效 / Invalid controller result.");
                        if (child.ExitCode != 0) reply.ok = false;
                        return reply;
                    }
                    Thread.Sleep(10);
                }
                throw new TimeoutException("控制命令或输出读取超时 / Controller or output timed out (" + limit + " ms).");
              }
            }
            catch (Exception problem)
            {
                bool cleaned;
                try { cleaned = StopControlProcesses(child, image, cleanupMs); }
                catch { cleaned = false; }
                throw new IOException(problem.Message
                    + (cleaned ? "\n本次控制命令已回收。 / This control command was reclaimed."
                        : "\n未能确认本次控制命令全部退出。 / Control-command cleanup could not be confirmed.")
                    + "\n已启动的 Fuli 服务可能仍运行；请刷新状态或查看日志。 / Started Fuli services may still be running; refresh status or inspect logs.", problem);
            }
        }
    }

    // No asynchronous ReadToEnd tasks are left waiting for inherited writers.
    // This is the sole reader of each pipe: read only bytes PeekNamedPipe says
    // are already buffered, and cap work per poll so noisy output cannot starve
    // the other stream or the overall deadline.
    private sealed class PipeCapture : IDisposable
    {
        private readonly SafeFileHandle pipe;
        private readonly MemoryStream bytes = new MemoryStream();
        private readonly byte[] buffer = new byte[4096];
        public bool Ended { get; private set; }
        public string Text { get { return Encoding.UTF8.GetString(bytes.ToArray()); } }
        public PipeCapture(Stream stream)
        {
            var file = stream as FileStream;
            if (file == null) throw new NotSupportedException("The .NET Framework redirected pipe is unavailable.");
            pipe = file.SafeFileHandle;
        }
        public void Drain()
        {
            for (int poll = 0; poll < 16 && !Ended; poll++)
            {
                uint available, ignored;
                if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, out ignored, out available, out ignored))
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code == 109 || code == 232) { Ended = true; return; }
                    throw new Win32Exception(code);
                }
                if (available == 0) return;
                uint read;
                if (!ReadFile(pipe, buffer, Math.Min((uint)buffer.Length, available), out read, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if (bytes.Length + read > 4 * 1024 * 1024) throw new IOException("Controller output exceeded 4 MiB.");
                bytes.Write(buffer, 0, (int)read);
            }
        }
        public void Dispose() { bytes.Dispose(); }
    }

    private static bool StopControlProcesses(Process controller, string image, int budgetMs)
    {
        var clock = Stopwatch.StartNew();
        var parent = controller.Handle;
        long created, exited, kernel, user;
        if (!GetProcessTimes(parent, out created, out exited, out kernel, out user)) return false;
        bool stopped = StopHandle(parent, Math.Min(budgetMs, 1000));
        if (!stopped) return false;
        if (!GetProcessTimes(parent, out created, out exited, out kernel, out user) || exited == 0) return false;

        // The controller creates only one kind of direct Node child: its
        // short-lived src/cli.js command. Console/Java/Python services are CLI
        // descendants. Never recurse into them, use taskkill /T, or kill by name.
        long snapshotStarted = DateTime.UtcNow.ToFileTimeUtc();
        using (var snapshot = new SafeFileHandle(CreateToolhelp32Snapshot(2, 0), true))
        {
            if (snapshot.IsInvalid) return false;
            var entry = new ProcessEntry { size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            if (!Process32First(snapshot, ref entry)) return Marshal.GetLastWin32Error() == 18;
            do
            {
                if (entry.parentPid != (uint)controller.Id) continue;
                using (var command = new SafeFileHandle(OpenProcess(0x100001 | 0x1000, false, entry.pid), true))
                {
                    if (command.IsInvalid)
                    {
                        if (String.Equals(entry.exe, Path.GetFileName(image), StringComparison.OrdinalIgnoreCase)) stopped = false;
                        continue;
                    }
                    long childCreated, childExited;
                    if (!GetProcessTimes(command.DangerousGetHandle(), out childCreated, out childExited, out kernel, out user)
                        || childCreated < created || childCreated > exited || childCreated > snapshotStarted
                        || !String.Equals(ImagePath(command.DangerousGetHandle()), image, StringComparison.OrdinalIgnoreCase)) continue;
                    int remaining = budgetMs - (int)clock.ElapsedMilliseconds;
                    if (remaining <= 0 || !StopHandle(command.DangerousGetHandle(), Math.Min(remaining, 1000))) stopped = false;
                }
            } while (Process32Next(snapshot, ref entry));
            if (Marshal.GetLastWin32Error() != 18) stopped = false;
        }
        return stopped && clock.ElapsedMilliseconds <= budgetMs;
    }

    private static bool StopHandle(IntPtr process, int waitMs)
    {
        if (WaitForSingleObject(process, 0) == 0) return true;
        if (!TerminateProcess(process, 1) && WaitForSingleObject(process, 0) != 0) return false;
        return WaitForSingleObject(process, (uint)Math.Max(0, waitMs)) == 0;
    }
    private static string ImagePath(IntPtr process)
    {
        var path = new StringBuilder(32768); int length = path.Capacity;
        return QueryFullProcessImageName(process, 0, path, ref length) ? path.ToString() : null;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint size, usage, pid;
        public IntPtr heap;
        public uint module, threads, parentPid;
        public int priority;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool PeekNamedPipe(SafeFileHandle pipe, IntPtr buffer, uint size, out uint read, out uint available, out uint left);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(SafeFileHandle pipe, byte[] buffer, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
}

public sealed class ControllerReply
{
    public bool ok { get; set; }
    public string error { get; set; }
    public string label { get; set; }
    // A failed start on a port Windows reserves; the tray offers "change-port".
    public bool portBlocked { get; set; }
    // What a completed action changed that the person should know, e.g. the new port.
    public string notice { get; set; }
    public string dataDir { get; set; }
    public string logDir { get; set; }
    public string nativeLogDir { get; set; }
    public string instanceKey { get; set; }
}
