import { execute, parsePowershellJson, powershellArguments } from '../local-runtime/windows-process-handle.js';

// The FULI stdio MCP servers of this installation that the OS shows running,
// recorded or not: a server started by a FULI older than process-registry.js
// writes no record, so only the process list can name it. A server is a
// process whose command line runs mcp-server.js with this installation's
// --runtime-config; worker (--worker) and one-shot (--call) runs are not
// sessions. Answers [{ pid, parentPid, startedAt }], or null when the list
// could not be read in time. A session can show more than one: the stdio
// relay (stdio-relay.js) and, on an installed Windows copy, FuliNode.exe run
// the same arguments as their server child.
const SCAN_TIMEOUT_MS = 5000;
const SERVER_SCRIPT = 'mcp-server.js';
const NOT_SESSIONS = ['--worker', '--call'];

const WINDOWS_SCRIPT = `$found = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${SERVER_SCRIPT}%'" | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; commandLine = $_.CommandLine;
    startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } })
ConvertTo-Json -Compress -Depth 3 -InputObject $found`;

// run(command, args, options) → { stdout }: execute() in production, a fake in tests.
export async function runningMcpServers(runtimeConfigPath, { platform = process.platform, run = execute } = {}) {
  try {
    const rows = platform === 'win32' ? await windowsRows(run) : await psRows(run);
    const wanted = platform === 'win32' ? runtimeConfigPath.toLowerCase() : runtimeConfigPath;
    return rows.filter(({ commandLine }) => {
      const command = platform === 'win32' ? commandLine.toLowerCase() : commandLine;
      return command.includes(SERVER_SCRIPT) && command.includes('--runtime-config') && command.includes(wanted)
        && !NOT_SESSIONS.some((flag) => command.includes(flag));
    }).map(({ pid, parentPid, startedAt }) => ({ pid, parentPid, startedAt }));
  } catch {
    return null;
  }
}

async function windowsRows(run) {
  const { stdout } = await run('powershell.exe', powershellArguments(WINDOWS_SCRIPT), { timeout: SCAN_TIMEOUT_MS });
  const rows = parsePowershellJson(stdout);
  return (Array.isArray(rows) ? rows : rows ? [rows] : []).filter((row) => typeof row.commandLine === 'string')
    .map((row) => ({ pid: row.pid, parentPid: row.parentPid, commandLine: row.commandLine,
      startedAt: typeof row.startedAt === 'string' ? new Date(row.startedAt).toISOString() : null }));
}

// lstart is read with TZ=UTC and LC_ALL=C, five fields: Tue Oct 27 10:15:30 2026.
async function psRows(run) {
  const { stdout } = await run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,lstart=,command='],
    { timeout: SCAN_TIMEOUT_MS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const started = new Date(`${match[3]} UTC`);
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), commandLine: match[4],
      startedAt: Number.isNaN(started.getTime()) ? null : started.toISOString() }];
  });
}
