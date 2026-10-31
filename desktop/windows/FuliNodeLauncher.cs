using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

// FuliNode.exe: the stable command of an installed FULI's client configurations
// (rec#11 D-80). Install, update and rollback copy it to the installation root,
// beside installation.json, and a client names it with a package-relative script:
//
//   "<install root>\FuliNode.exe" src\mcp-server.js --runtime-config ...
//
// At each launch it reads installation.json's packageRoot (every version writes
// one) and runs that version's runtime\node\node.exe with the script inside that
// version, so an update or rollback changes no client configuration. Without an
// installation.json beside it (a package or slot copy), it runs its own folder.
//
// The client's arguments, working directory, environment, standard handles and
// node's exit code pass through unchanged: an MCP server speaks JSON-RPC on stdio
// and a lifecycle hook reads stdin and writes stdout as if the client had started
// node itself. A console program, so it shares the caller's console and opens no
// window of its own. node runs in a job closed with this process, so a client that
// kills this process (a hook's deadline) also ends node; the job allows breakaway,
// as Node's own does, so node's detached children keep running.
internal static class FuliNodeLauncher
{
    private const int UsageError = 1;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) throw new LaunchError("Usage: FuliNode.exe <package-relative script> [arguments]");
            var root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            var packageRoot = CurrentPackageRoot(root);
            var node = Path.Combine(packageRoot, "runtime\\node\\node.exe");
            if (!File.Exists(node)) throw new LaunchError("The installed FULI has no bundled Node.js; reinstall or update FULI: " + node);
            var command = new StringBuilder(Quote(node)).Append(' ').Append(Quote(PackageScript(packageRoot, args[0])));
            for (var index = 1; index < args.Length; index++) command.Append(' ').Append(Quote(args[index]));
            return Run(node, command);
        }
        catch (LaunchError error)
        {
            Console.Error.WriteLine("FULI: " + error.Message);
            return UsageError;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("FULI could not start Node.js: " + error.Message);
            return UsageError;
        }
    }

    // The current version: installation.json names it, inside this root's versions folder.
    private static string CurrentPackageRoot(string root)
    {
        var recordPath = Path.Combine(root, "installation.json");
        if (!File.Exists(recordPath)) return root.TrimEnd('\\');
        object value = null;
        try
        {
            var record = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(recordPath, Encoding.UTF8));
            if (record != null) record.TryGetValue("packageRoot", out value);
        }
        catch (Exception error) { throw new LaunchError("The installation record cannot be read: " + recordPath + " (" + error.Message + ")"); }
        var packageRoot = value as string;
        if (string.IsNullOrEmpty(packageRoot) || !Path.IsPathRooted(packageRoot)) throw new LaunchError("The installation record names no version: " + recordPath);
        packageRoot = Path.GetFullPath(packageRoot).TrimEnd('\\');
        var versions = Path.Combine(root, "versions");
        if (!string.Equals(Path.GetDirectoryName(packageRoot), versions, StringComparison.OrdinalIgnoreCase))
            throw new LaunchError("The installation record names a version outside " + versions);
        return packageRoot;
    }

    // Only a script of the current version runs; an absolute path or one leaving it is refused.
    private static string PackageScript(string packageRoot, string relative)
    {
        if (relative.Length == 0 || Path.IsPathRooted(relative)) throw new LaunchError("Name the script relative to the FULI package, for example src\\mcp-server.js.");
        var script = Path.GetFullPath(Path.Combine(packageRoot, relative));
        if (!script.StartsWith(packageRoot + "\\", StringComparison.OrdinalIgnoreCase)) throw new LaunchError("The script is outside the FULI package: " + relative);
        if (!File.Exists(script)) throw new LaunchError("The installed FULI has no " + relative + "; update FULI or run its setup again.");
        return script;
    }

    // The standard Windows argument quoting (CommandLineToArgvW), which Node parses back.
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static int Run(string node, StringBuilder command)
    {
        // Ctrl+C and Ctrl+Break reach node on the shared console; node decides, this waits for its exit code.
        SetConsoleCtrlHandler(IgnoreControl, true);
        var current = GetCurrentProcess();
        var stdio = new IntPtr[3];
        var owned = new bool[3];
        for (var index = 0; index < 3; index++)
        {
            var handle = GetStdHandle(-10 - index);
            stdio[index] = handle;
            // An inheritable duplicate: the caller's pipe or console, whatever it passed this process.
            if (handle != IntPtr.Zero && handle != InvalidHandle)
                owned[index] = DuplicateHandle(current, handle, current, out stdio[index], 0, true, DuplicateSameAccess);
            if (!owned[index]) stdio[index] = handle;
        }
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.basic.flags = KillOnJobClose | BreakawayOk | SilentBreakawayOk;
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
        var startup = new StartupInfo();
        startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
        startup.flags = UseStdHandles;
        startup.input = stdio[0];
        startup.output = stdio[1];
        startup.error = stdio[2];
        ProcessInfo process;
        // Suspended until it is in the job, so no descendant starts outside it.
        if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended, IntPtr.Zero, null, ref startup, out process))
            throw new Win32Exception();
        for (var index = 0; index < 3; index++) if (owned[index]) CloseHandle(stdio[index]);
        // A job that refuses nesting leaves node running without it rather than not at all.
        AssignProcessToJobObject(job, process.process);
        ResumeThread(process.thread);
        CloseHandle(process.thread);
        WaitForSingleObject(process.process, Infinite);
        uint code;
        if (!GetExitCodeProcess(process.process, out code)) throw new Win32Exception();
        CloseHandle(process.process);
        return unchecked((int)code);
    }

    private sealed class LaunchError : Exception
    {
        public LaunchError(string message) : base(message) { }
    }

    private delegate bool ControlHandler(uint kind);
    // Kept in a field: the console calls it after Run returns its stack frame.
    private static readonly ControlHandler IgnoreControl = kind => kind <= 1;

    private static readonly IntPtr InvalidHandle = new IntPtr(-1);
    private const uint DuplicateSameAccess = 2, UseStdHandles = 0x100, CreateSuspended = 4, Infinite = 0xFFFFFFFF;
    private const int ExtendedLimitInformation = 9;
    private const uint BreakawayOk = 0x800, SilentBreakawayOk = 0x1000, KillOnJobClose = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint cb; public IntPtr reserved, desktop, title;
        public uint x, y, width, height, charsX, charsY, fill, flags;
        public ushort showWindow, reservedBytes; public IntPtr reservedData, input, output, error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr process, thread; public uint pid, threadId; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet; public uint activeProcesses;
        public UIntPtr affinity; public uint priority, scheduling;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetConsoleCtrlHandler(ControlHandler handler, bool add);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
