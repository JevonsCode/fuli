using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// The helper alone owns the job handle. It is never inherited by the adapter.
// See https://learn.microsoft.com/windows/win32/procthread/job-objects
public static class FuliJobProcess {
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
    public uint cb; public IntPtr reserved, desktop, title;
    public uint x, y, width, height, charsX, charsY, fill, flags;
    public ushort showWindow, reservedBytes; public IntPtr reservedData, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
    public StartupInfo startup; public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr process, thread; public uint pid, threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minimumWorkingSet, maximumWorkingSet; public uint activeProcesses;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long userTime, kernelTime, periodUserTime, periodKernelTime;
    public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
      result.Append(character); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static uint Active(IntPtr job) {
    Accounting value;
    Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return value.activeProcesses;
  }
  // This is bounded diagnostic data. Termination always uses the job, never PIDs.
  static string Members(IntPtr job) {
    int size = 8 + IntPtr.Size * 64; IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      bool success = QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero);
      if (!success && Marshal.GetLastWin32Error() != 234) throw new Win32Exception(Marshal.GetLastWin32Error());
      int count = Math.Min(64, Marshal.ReadInt32(buffer, 4));
      var result = new StringBuilder("[");
      for (int index = 0; index < count; index++) {
        if (index != 0) result.Append(',');
        result.Append(Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64());
      }
      return result.Append(']').ToString();
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static int Run(string command, string[] args, string cwd, string[] environment,
      StreamReader control, StreamWriter status, uint stopTimeout) {
    IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero, block = IntPtr.Zero;
    var stdio = new IntPtr[3]; var process = new ProcessInfo();
    var gate = new object(); var stopping = new ManualResetEvent(false);
    bool attributesInitialized = false, assigned = false, jobClosed = false, ready = false;
    Action<string> send = value => { lock (status) { status.WriteLine(value); status.Flush(); } };
    try {
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
      var limits = new ExtendedLimits();
      // KILL_ON_JOB_CLOSE; neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is set.
      limits.basic.flags = 0x2000;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); attributesInitialized = true;
      handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
      for (int index = 0; index < stdio.Length; index++) {
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10 - index), GetCurrentProcess(), out stdio[index], 0, true, 2));
        Marshal.WriteIntPtr(handles, index * IntPtr.Size, stdio[index]);
      }
      // Only ACP stdio crosses this boundary; no control pipe or job handle does.
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
      var startup = new StartupInfoEx(); startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
      startup.startup.flags = 0x101; startup.startup.input = stdio[0];
      startup.startup.output = stdio[1]; startup.startup.error = stdio[2]; startup.attributes = attributes;
      var line = new StringBuilder(Quote(command));
      foreach (string argument in args) line.Append(' ').Append(Quote(argument));
      Array.Sort(environment, StringComparer.OrdinalIgnoreCase);
      block = Marshal.StringToHGlobalUni(String.Join("\0", environment) + "\0\0");
      // Suspended creation closes the spawn/assignment race, including very fast descendants.
      Check(CreateProcess(command, line, IntPtr.Zero, IntPtr.Zero, true, 0x08080404, block, cwd, ref startup, out process));
      Check(AssignProcessToJobObject(job, process.process)); assigned = true;
      Check(ResumeThread(process.thread) != UInt32.MaxValue);
      ready = true;
      send("{\"type\":\"ready\",\"pid\":" + process.pid + ",\"pids\":" + Members(job) + "}");
      var reader = new Thread(() => {
        try {
          string request;
          while ((request = control.ReadLine()) == "snapshot") {
            lock (gate) {
              if (jobClosed) break;
              send("{\"type\":\"snapshot\",\"pids\":" + Members(job) + "}");
            }
          }
        } catch { } finally { stopping.Set(); }
      });
      reader.IsBackground = true; reader.Start();
      uint waited = WaitForMultipleObjects(2, new [] { process.process, stopping.SafeWaitHandle.DangerousGetHandle() }, false, UInt32.MaxValue);
      if (waited > 1) throw new Win32Exception();
      lock (gate) {
        Check(TerminateJobObject(job, 0));
        var deadline = DateTime.UtcNow.AddMilliseconds(stopTimeout);
        while (Active(job) != 0) {
          if (DateTime.UtcNow >= deadline) throw new TimeoutException();
          Thread.Sleep(10);
        }
        jobClosed = true;
      }
      send("{\"type\":\"closed\",\"activeProcesses\":0}");
      return 0;
    } catch {
      try { send("{\"type\":\"error\",\"code\":\"" + (ready ? "cleanup_incomplete" : "launch_failed") + "\"}"); } catch { }
      return 1;
    } finally {
      lock (gate) {
        jobClosed = true;
        // If assignment failed the still-suspended process cannot have descendants.
        if (process.process != IntPtr.Zero && !assigned) { TerminateProcess(process.process, 1); WaitForSingleObject(process.process, stopTimeout); }
        if (job != IntPtr.Zero) CloseHandle(job);
      }
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      foreach (IntPtr handle in stdio) if (handle != IntPtr.Zero) CloseHandle(handle);
      if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
    }
  }
}
