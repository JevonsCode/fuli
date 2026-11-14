import { execute, parsePowershellJson, powershellArguments } from '../local-runtime/windows-process-handle.js';

// FULI processes of one data directory that the OS shows running, recorded or
// not, by the --runtime-config their command line names. Each answers
// [{ pid, parentPid, startedAt }], or null when the list could not be read in time.
const SCAN_TIMEOUT_MS = 5000;
const MCP_SCRIPT = 'mcp-server.js';
const NOT_SESSIONS = ['--worker', '--call'];
// The console's entry, src/server.js (not mcp-server.js).
const CONSOLE_SCRIPT = /[\\/]src[\\/]server\.js\b/;

// Every command line naming server.js (the console's and the MCP server's); each scan filters its own.
const WINDOWS_SCRIPT = `$found = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%server.js%'" | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; commandLine = $_.CommandLine;
    startedAt = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } })
ConvertTo-Json -Compress -Depth 3 -InputObject $found`;

// The stdio MCP servers of this installation: a server started by a FULI
// older than process-registry.js writes no record, so only the process list
// can name it. Worker (--worker) and one-shot (--call) runs are not sessions.
// A session can show more than one: the stdio relay (stdio-relay.js) and, on
// an installed Windows copy, FuliNode.exe run the same arguments as their server child.
// run(command, args, options) → { stdout }: execute() in production, a fake in tests.
export function runningMcpServers(runtimeConfigPath, options = {}) {
  return scan(runtimeConfigPath, command => command.includes(MCP_SCRIPT) && !NOT_SESSIONS.some((flag) => command.includes(flag)),
    options);
}

// The consoles serving this data directory, recorded or not: one a start
// gave up on, or whose start was killed, is in no record a stop reads.
export function runningConsoles(runtimeConfigPath, options = {}) {
  return scan(runtimeConfigPath, command => CONSOLE_SCRIPT.test(command), options);
}

async function scan(runtimeConfigPath, matches, { platform = process.platform, run = execute } = {}) {
  try {
    const rows = platform === 'win32' ? await windowsRows(run) : await psRows(run);
    // Windows and macOS compare paths without case; Windows also either separator.
    const fold = platform === 'win32' ? value => value.replaceAll('\\', '/').toLowerCase()
      : platform === 'darwin' ? value => value.toLowerCase() : value => value;
    const wanted = fold(runtimeConfigPath);
    return rows.filter(({ commandLine }) => {
      const command = fold(commandLine);
      return namesRuntimeConfig(command, wanted) && matches(command);
    }).map(({ pid, parentPid, startedAt }) => ({ pid, parentPid, startedAt }));
  } catch {
    return null;
  }
}

// Whether the argument after --runtime-config is exactly this path (optionally
// quoted), not one that merely contains it (/y/x/.fuli/… holds /x/.fuli/…).
function namesRuntimeConfig(command, wanted) {
  const flag = /--runtime-config[=\s]\s*"?/g;
  for (let found = flag.exec(command); found; found = flag.exec(command)) {
    const rest = command.slice(found.index + found[0].length);
    if (rest.startsWith(wanted) && /^(?:$|["\s])/.test(rest.slice(wanted.length))) return true;
  }
  return false;
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
