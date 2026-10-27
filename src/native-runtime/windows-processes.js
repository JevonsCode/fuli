import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { basename, dirname, join, normalize, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { openChildProcessLog } from '../local-runtime/child-process-log.js';
import { execute, OWNED_PROCESS_TYPE, powershell } from '../local-runtime/windows-process-handle.js';

const samePath = (left, right) => typeof left === 'string' && typeof right === 'string'
  && normalize(left).toLowerCase() === normalize(right).toLowerCase();

export async function inspectWindowsNativeProcess(pid, { children = false, descendants = false, timeoutMs = 60_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return children || descendants ? [] : null;
  const filter = 'ProcessId = ' + pid + (children ? ' OR ParentProcessId = ' + pid : '');
  // One CIM snapshot avoids a fresh PowerShell process for each descendant.
  // This is observation only; callers still verify identities before stopping them.
  const selection = descendants
    ? '$all = @(Get-CimInstance Win32_Process);'
      + '$ids = [System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(' + pid + ');'
      + 'do {$added = $false;foreach ($item in $all) {'
      + 'if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) {$added = $true}'
      + '}} while ($added);$selected = @($all | Where-Object {$ids.Contains([int]$_.ProcessId)});'
    : '$selected = @(Get-CimInstance Win32_Process -Filter "' + filter + '");';
  const script = selection + '$rows = @($selected | ForEach-Object {'
    + '[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;'
    + 'executable=$_.ExecutablePath;commandLine=$_.CommandLine;'
    + 'createdFileTime=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}});'
    + 'ConvertTo-Json -InputObject $rows -Compress';
  const rows = await powershell(script, process.env, { timeout: timeoutMs });
  return children || descendants ? rows : rows.find(row => row.pid === pid) ?? null;
}

function identityMatches(observed, ownership) {
  return observed && ownership && samePath(observed.executable, ownership.executable)
    && observed.createdFileTime === ownership.createdFileTime
    && observed.commandLine === ownership.commandLine;
}

export async function windowsNativeProcessMatches(pid, command, entry, options) {
  if (!entry?.ownership || !samePath(command, entry.ownership.executable)) return false;
  return Boolean(identityMatches(await inspectWindowsNativeProcess(pid, options), entry.ownership));
}

// Listening owners on every local address, so a 0.0.0.0 or [::] listener that
// would also answer 127.0.0.1 is visible, not only an exact loopback bind.
async function listeningOwners(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid native service port');
  return powershell('$owners = @(Get-NetTCPConnection -State Listen -LocalPort ' + port
    + ' -ErrorAction SilentlyContinue | ForEach-Object {[pscustomobject]@{pid=[int]$_.OwningProcess;'
    + 'name=(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}} | Sort-Object pid -Unique);'
    + 'ConvertTo-Json -InputObject $owners -Compress');
}

// Before spawning: a port another process already holds would let the readiness
// probe reach that process and end in a misleading ownership failure.
export async function assertWindowsNativePortFree(port) {
  const owners = await listeningOwners(port);
  if (owners.length) {
    const observed = owners.map(owner => owner.pid + (owner.name ? ' (' + owner.name + ')' : '')).join(', ');
    throw new Error('The native service port is already in use before Fuli starts its process: ' + port
      + ' (owner PIDs: ' + observed + '). The owning process was not touched and the service for this port was not started; stop that process or choose another port.');
  }
}

export async function assertWindowsNativePortOwner(entry, port) {
  await refreshProviderChild(entry);
  const owners = (await listeningOwners(port)).map(owner => owner.pid);
  const owned = new Set([entry.pid, ...(entry.relatedProcesses ?? []).map(item => item.pid)]);
  if (!owners.length || owners.some(pid => !owned.has(pid))) {
    const expected = [...owned].filter(Number.isInteger).join(',') || 'none';
    const observed = owners.filter(Number.isInteger).join(',') || 'none';
    throw new Error('The native service port does not belong to its recorded process: ' + port
      + ' (' + (owners.length ? 'foreign' : 'empty') + '; expected PIDs: ' + expected + '; observed PIDs: ' + observed + ')');
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
const STOP_SCRIPT = OWNED_PROCESS_TYPE + `
$owner = $env:FULI_NATIVE_PROCESS_OWNER | ConvertFrom-Json
$observed = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $owner.pid)
$stopped = $false
if ($observed -and $observed.CommandLine -ceq $owner.commandLine) {
  $stopped = [FuliOwnedProcess]::Stop($owner.pid, [long]$owner.createdFileTime, $owner.executable)
}
@{stopped=$stopped} | ConvertTo-Json -Compress
`;

export async function stopWindowsNativeProcess(pid, entry, { timeoutMs } = {}) {
  const started = Date.now();
  const remaining = () => {
    const value = timeoutMs === undefined ? 60_000 : timeoutMs - (Date.now() - started);
    if (value <= 0) throw new Error('Native process stop timed out');
    return value;
  };
  if (!Number.isInteger(pid) || !entry?.ownership) return;
  if (!await windowsNativeProcessMatches(pid, entry.command, entry, { timeoutMs: remaining() })) return;
  await refreshProviderChild(entry);
  for (const item of [{ pid: entry.pid, ownership: entry.ownership }, ...(entry.relatedProcesses ?? [])]) {
    if (!Number.isInteger(item.pid) || !item.ownership) continue;
    const result = await powershell(STOP_SCRIPT, { ...process.env,
      FULI_NATIVE_PROCESS_OWNER: JSON.stringify({ ...item.ownership, pid: item.pid }) }, { timeout: remaining() });
    if (!result?.stopped && identityMatches(await inspectWindowsNativeProcess(item.pid, { timeoutMs: remaining() }), item.ownership)) {
      throw new Error('The verified native process could not be stopped; ownership state must be retained');
    }
  }
}

async function spawnOwned(command, args, environment, logPath, { provider = false } = {}) {
  const log = openChildProcessLog(logPath);
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
    env, sensitiveValues: neo4jAdminSensitiveValues(args)
  });
}

export function neo4jAdminSensitiveValues(args) {
  return args[0] === 'dbms' && args[1] === 'set-initial-password'
    ? args.slice(2).filter(value => value !== '--') : [];
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

// Read-only boot-anchor evidence for an unconfirmed cleanup hold: the single
// session-0 wininit, its image, and whether Windows reports it critical, plus a
// salted machine hash. No CommandLine is read. Any error, other platform, missing
// field, or more/less than one anchor returns null, which keeps every hold.
const BOOT_ANCHOR_SCRIPT = [
  'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class FuliAnchor {',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, uint p);',
  '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessCritical(IntPtr h, out bool c);',
  '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
  'public static object Critical(uint p) { IntPtr h = OpenProcess(0x1000, false, p); if (h == IntPtr.Zero) return null;',
  'try { bool c; return IsProcessCritical(h, out c) ? (object)c : null; } finally { CloseHandle(h); } } }\';',
  '$anchors = @(Get-CimInstance Win32_Process -Filter "Name = \'wininit.exe\' AND SessionId = 0" | ForEach-Object {',
  '[pscustomobject]@{ pid = [int]$_.ProcessId; image = $_.ExecutablePath; critical = [FuliAnchor]::Critical([uint32]$_.ProcessId) } });',
  '$guid = (Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Cryptography" -Name MachineGuid).MachineGuid;',
  'ConvertTo-Json -Compress -InputObject @{ anchors = $anchors; machineGuid = $guid }'
].join(' ');

export async function readWindowsBootAnchor({ salt, platform = process.platform, run = powershell } = {}) {
  if (platform !== 'win32' || typeof salt !== 'string' || !salt) return null;
  try {
    const result = await run(BOOT_ANCHOR_SCRIPT, process.env, { timeout: 15_000 });
    const anchors = Array.isArray(result?.anchors) ? result.anchors : [result?.anchors].filter(Boolean);
    const [anchor] = anchors;
    if (anchors.length !== 1 || !Number.isInteger(anchor.pid) || anchor.pid <= 0 || anchor.critical !== true
        || typeof anchor.image !== 'string' || win32.basename(anchor.image).toLowerCase() !== 'wininit.exe'
        || typeof result.machineGuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(result.machineGuid)) return null;
    const machineHash = createHash('sha256').update(salt + ':' + result.machineGuid.toLowerCase()).digest('hex');
    return { version: 1, machineHash, anchor: { pid: anchor.pid, image: 'wininit.exe', critical: true } };
  } catch { return null; }
}
