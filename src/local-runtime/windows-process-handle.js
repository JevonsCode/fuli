import { execFile } from 'node:child_process';
import { basename } from 'node:path';

// Windows process work that must hold one process handle from the identity
// check to the end: the one P/Invoke type FULI compiles (Add-Type) for it, and
// the PowerShell runner every caller uses. The native runtime stops the
// Neo4j and Provider processes it started with Stop: a PID reused after a read
// can never redirect that termination, because the handle is opened before
// the check and the termination and the wait use it. The Agent app owner
// lease (src/agent-apps/host-identity.js) only reads a FULI host process's
// exact creation time and whether it has exited (rec#7 D-28.25); it never
// terminates one (D-28.29, rec#11 D-36). The services manager stops a service
// an Agent recorded with Stop, after the person confirmed its PID and command
// (src/agent-services/process-identity.js, rec#11 D-71).

export function execute(command, args, options = {}) {
  const { sensitiveValues = [], ...executionOptions } = options;
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, ...executionOptions
  }, (error, stdout, stderr) => {
    const clean = value => sensitiveValues.reduce((result, secret) => secret
      ? result.replaceAll(secret, '[redacted]') : result, value);
    if (error) reject(new Error(clean(stderr.trim() || stdout.trim()).slice(0, 2000)
      || ('Native ' + basename(command) + ' failed: ' + (error.code ?? error.signal ?? 'unknown'))));
    else resolve({ stdout: clean(stdout), stderr: clean(stderr) });
  }));
}

export async function powershell(script, env = process.env, options = {}) {
  const prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference="Stop"; ';
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(prefix + script, 'utf16le').toString('base64')], { env, ...options });
  return JSON.parse(result.stdout.replace(/^﻿/, '').trim() || 'null');
}

// Stop keeps the native runtime's check (image path, creation time to the
// microsecond). Created and Probe compare the raw 100 ns FILETIME exactly and
// open the process for query and wait only. OpenProcess failing with
// ERROR_INVALID_PARAMETER means no such process; any other failure (access
// denied) is unknown, never exited. A signaled handle (the process has
// exited, though another handle keeps its object) is exited.
export const OWNED_PROCESS_TYPE = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FuliOwnedProcess {
  const uint QueryLimited = 0x1000, Synchronize = 0x100000, Terminate = 0x0001;
  const int InvalidParameter = 87;
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Stop(uint pid, long expectedCreated, string expectedImage) {
    IntPtr handle = OpenProcess(Synchronize | Terminate | QueryLimited, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      long created, exited, kernel, user;
      int size=32768; var image=new StringBuilder(size);
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)
          || created / 10 != expectedCreated / 10
          || !QueryFullProcessImageName(handle, 0, image, ref size)
          || !String.Equals(image.ToString(), expectedImage, StringComparison.OrdinalIgnoreCase)) return false;
      if (!TerminateProcess(handle, 0)) throw new System.ComponentModel.Win32Exception();
      if (WaitForSingleObject(handle, 10000) != 0) throw new Exception("Owned process did not exit");
      return true;
    } finally { CloseHandle(handle); }
  }
  static IntPtr Open(uint pid, uint access, out string failure) {
    IntPtr handle = OpenProcess(access, false, pid);
    failure = handle != IntPtr.Zero ? null : (Marshal.GetLastWin32Error() == InvalidParameter ? "exited" : "unknown");
    return handle;
  }
  public static string Created(uint pid) {
    string failure;
    IntPtr handle = Open(pid, QueryLimited, out failure);
    if (handle == IntPtr.Zero) return "";
    try {
      long created, exited, kernel, user;
      return GetProcessTimes(handle, out created, out exited, out kernel, out user) ? created.ToString() : "";
    } finally { CloseHandle(handle); }
  }
  // The image path as Stop compares it (a symbolic link resolved), or "".
  public static string Image(uint pid) {
    string failure;
    IntPtr handle = Open(pid, QueryLimited, out failure);
    if (handle == IntPtr.Zero) return "";
    try {
      int size=32768; var image=new StringBuilder(size);
      return QueryFullProcessImageName(handle, 0, image, ref size) ? image.ToString() : "";
    } finally { CloseHandle(handle); }
  }
  public static string Probe(uint pid, long expectedCreated) {
    string failure;
    IntPtr handle = Open(pid, QueryLimited | Synchronize, out failure);
    if (handle == IntPtr.Zero) return failure;
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) return "unknown";
      if (created != expectedCreated) return "exited";
      return WaitForSingleObject(handle, 0) == 0 ? "exited" : "alive";
    } finally { CloseHandle(handle); }
  }
}
'@
`;
