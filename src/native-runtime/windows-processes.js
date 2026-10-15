import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && normalize(left).toLowerCase() === normalize(right).toLowerCase();

function execute(command, args, options = {}) {
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

async function powershell(script, env = process.env) {
  const prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference="Stop"; ';
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(prefix + script, 'utf16le').toString('base64')], { env });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim() || 'null');
}

export async function inspectWindowsNativeProcess(pid, { children = false } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return children ? [] : null;
  const filter = 'ProcessId = ' + pid + (children ? ' OR ParentProcessId = ' + pid : '');
  const script = '$rows = @(Get-CimInstance Win32_Process -Filter "' + filter + '" | ForEach-Object {'
    + '[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;'
    + 'executable=$_.ExecutablePath;commandLine=$_.CommandLine;'
    + 'createdFileTime=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}});'
    + 'ConvertTo-Json -InputObject $rows -Compress';
  const rows = await powershell(script);
  return children ? rows : rows.find(row => row.pid === pid) ?? null;
}

function identityMatches(observed, ownership) {
  return observed && ownership && samePath(observed.executable, ownership.executable)
    && observed.createdFileTime === ownership.createdFileTime
    && observed.commandLine === ownership.commandLine;
}

export async function windowsNativeProcessMatches(pid, command, entry) {
  if (!entry?.ownership || !samePath(command, entry.ownership.executable)) return false;
  return Boolean(identityMatches(await inspectWindowsNativeProcess(pid), entry.ownership));
}

export async function assertWindowsNativePortOwner(entry, port) {
  await refreshProviderChild(entry);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native service port');
  const owners = await powershell('$owners = @(Get-NetTCPConnection -State Listen -LocalPort ' + port
    + ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique);'
    + 'ConvertTo-Json -InputObject $owners -Compress');
  const owned = new Set([entry.pid, ...(entry.relatedProcesses ?? []).map(item => item.pid)]);
  if (!owners.length || owners.some(pid => !owned.has(pid))) {
    throw new Error('The native service port does not belong to its recorded process: ' + port);
  }
}

async function refreshProviderChild(entry) {
  const launcher = entry.launcher;
  if (!launcher || !entry.providerArguments) return;
  const rows = await inspectWindowsNativeProcess(launcher.pid, { children: true });
  if (!identityMatches(rows.find(row => row.pid === launcher.pid), launcher.ownership)) return;
  const child = rows.find(row => row.parentPid === launcher.pid && row.executable
    && BigInt(row.createdFileTime) >= BigInt(launcher.ownership.createdFileTime)
    && providerArgumentsMatch(row.commandLine, entry.providerArguments));
  if (!child) return;
  entry.pid = child.pid;
  entry.command = child.executable;
  entry.ownership = child;
  entry.relatedProcesses = [launcher];
}

function providerArgumentsMatch(commandLine, args) {
  // Provider arguments are separate Node argv elements; Windows filenames
  // cannot contain double quotes and resolved directory arguments do not end in a slash.
  const words = [...String(commandLine).matchAll(/"([^"]*)"|([^\s"]+)/g)].map(match => match[1] ?? match[2]);
  return words.slice(-args.length).every((word, index) => word === args[index]) && words.length > args.length;
}

export async function waitForWindowsNativeDatabase(host, port, entry) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    try { process.kill(entry.pid, 0); }
    catch { throw new Error('The owned native Neo4j process exited before opening its Bolt port'); }
    const ready = await new Promise(resolve => {
      const socket = createConnection({ host, port });
      const done = value => { socket.destroy(); resolve(value); };
      socket.setTimeout(100, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (ready) return;
    await delay(100);
  }
  throw new Error('Native Neo4j did not open its isolated Bolt port');
}

// Hold a process handle while checking its image and creation time and stopping
// it. A PID reused after the CIM read cannot redirect termination to a new process.
const STOP_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FuliOwnedProcess {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Stop(uint pid, long expectedCreated, string expectedImage) {
    IntPtr handle = OpenProcess(0x100001 | 0x1000, false, pid);
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
}
'@
$owner = $env:FULI_NATIVE_PROCESS_OWNER | ConvertFrom-Json
$observed = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $owner.pid)
$stopped = $false
if ($observed -and $observed.CommandLine -ceq $owner.commandLine) {
  $stopped = [FuliOwnedProcess]::Stop($owner.pid, [long]$owner.createdFileTime, $owner.executable)
}
@{stopped=$stopped} | ConvertTo-Json -Compress
`;

export async function stopWindowsNativeProcess(pid, entry) {
  if (!Number.isInteger(pid) || !entry?.ownership) return;
  if (!await windowsNativeProcessMatches(pid, entry.command, entry)) return;
  await refreshProviderChild(entry);
  for (const item of [{ pid: entry.pid, ownership: entry.ownership }, ...(entry.relatedProcesses ?? [])]) {
    if (!Number.isInteger(item.pid) || !item.ownership) continue;
    const result = await powershell(STOP_SCRIPT, { ...process.env,
      FULI_NATIVE_PROCESS_OWNER: JSON.stringify({ ...item.ownership, pid: item.pid }) });
    if (!result?.stopped && identityMatches(await inspectWindowsNativeProcess(item.pid), item.ownership)) {
      throw new Error('The verified native process could not be stopped; ownership state must be retained');
    }
  }
}

async function spawnOwned(command, args, environment, logPath, { provider = false } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  let child;
  try {
    child = spawn(command, args, { detached: true, windowsHide: true,
      stdio: ['ignore', log, log], env: environment });
    await once(child, 'spawn');
    const rows = await inspectWindowsNativeProcess(child.pid, { children: true });
    const root = rows.find(row => row.pid === child.pid);
    if (!root?.executable || !root.commandLine || !samePath(root.executable, command)) {
      throw new Error('Cannot verify the new native process ownership');
    }
    // Windows venv python.exe can be a launcher. Record its real child too,
    // rather than stopping only the launcher and leaving Uvicorn listening.
    const python = provider && rows.find(row => row.parentPid === child.pid
      && row.executable && row.commandLine?.includes('uvicorn'));
    const main = python || root;
    child.unref();
    return { pid: main.pid, command: main.executable, ownership: main,
      ...(provider ? { launcher: { pid: root.pid, ownership: root }, providerArguments: args } : {}),
      relatedProcesses: rows.filter(row => row.pid !== main.pid && row.executable && row.commandLine)
        .map(row => ({ pid: row.pid, ownership: row })) };
  } catch (error) {
    child?.kill();
    throw error;
  } finally { closeSync(log); }
}

export async function runWindowsNeo4j(command, args, { env }) {
  if (basename(command) !== 'neo4j-admin') throw new Error('Unowned Windows Neo4j command is not supported');
  const home = dirname(dirname(command));
  // AdminTool uses a typed home path. The outer bootloader escapes non-ASCII
  // Windows paths through its PATH setting parser, even for set-initial-password.
  return execute(join(env.JAVA_HOME, 'bin', 'java.exe'), ['-cp', join(home, 'lib', '*'),
    'org.neo4j.cli.AdminTool', ...args], {
    env, sensitiveValues: args[0] === 'dbms' && args[1] === 'set-initial-password' ? [args[2]] : []
  });
}

export function spawnWindowsNativeDatabase(spec) {
  const home = dirname(dirname(spec.command));
  const defaults = readFileSync(join(home, 'conf', 'neo4j.conf'), 'utf8').split(/\r?\n/)
    .filter(line => line.startsWith('server.jvm.additional='))
    .map(line => line.slice('server.jvm.additional='.length).trim()).filter(Boolean);
  return spawnOwned(join(spec.environment.JAVA_HOME, 'bin', 'java.exe'), [
    '-cp', join(home, 'lib', '*'), ...defaults, '-Dfile.encoding=UTF-8',
    '-Xms' + spec.memory.heapInitial, '-Xmx' + spec.memory.heapMax,
    'org.neo4j.server.CommunityEntryPoint', '--home-dir=' + spec.environment.NEO4J_HOME,
    '--config-dir=' + spec.environment.NEO4J_CONF, '--console-mode'
  ], spec.environment, spec.logPath);
}

export function spawnWindowsNativeProvider(spec) {
  return spawnOwned(spec.python, ['-B', '-X', 'utf8', '-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1',
    '--port', String(spec.port), '--app-dir', spec.sourcePath],
  spec.environment, spec.logPath, { provider: true });
}
