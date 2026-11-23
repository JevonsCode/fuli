import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Cursor's CLI asks two questions the first time it runs in a project folder:
// whether to trust the folder, and whether to approve each MCP server. Started
// by something that cannot answer them — a background process, another Agent —
// it waits with no output at all, which reads as a session that started and
// then did nothing (rec#145).
//
// Checked against the installed CLI and Cursor's own documentation rather than
// from memory, because the two disagree:
//   * cursor.com/docs/cli/reference/parameters lists `--trust`, "Trust the
//     workspace without prompting (headless mode only)", but the installed
//     cursor-agent 2026.01.23-916f423 answers `error: unknown option '--trust'`
//     and its `--help` does not list it. FULI never passes it.
//   * `--approve-mcps` is accepted, and that build's own help says it "only
//     works with --print/headless mode", so it does nothing for an interactive run.
//   * `cursor-agent mcp enable <name>` is documented as "Add an MCP server to
//     the local approved list". Run in a folder it writes
//     ~/.cursor/projects/<folder>/mcp-approvals.json (an entry `<name>-<hash>`),
//     so an approval covers that one folder; `--workspace` does not change
//     where it lands, only the working directory does.
// So FULI offers that one command, run in a folder the person names, only while
// Cursor's CLI is installed here and has approved FULI in no folder yet. It
// never fakes a hook or passes a flag the CLI would refuse. The words the person
// reads live in the console's messages only (settings.connection.clients.firstRun).

const PROGRAM = 'cursor-agent';
const ARGS = Object.freeze(['mcp', 'enable', 'fuli']);
export const CURSOR_APPROVE_COMMAND = `${PROGRAM} ${ARGS.join(' ')}`;
// Long enough for the CLI to start and write; past it, it is waiting on a question nobody sees.
const ANSWER_WITHIN_MS = 20_000;
const MAX_OUTPUT = 300;

// Whether Cursor's CLI has approved FULI's MCP server in any folder yet.
export function fuliApprovedSomewhere({ homeDir = homedir() } = {}) {
  const projects = join(homeDir, '.cursor', 'projects');
  let folders;
  try { folders = readdirSync(projects); } catch { return false; }
  return folders.some((folder) => {
    try {
      const approved = JSON.parse(readFileSync(join(projects, folder, 'mcp-approvals.json'), 'utf8'));
      return Array.isArray(approved) && approved.some((entry) => typeof entry === 'string' && entry.startsWith('fuli-'));
    } catch {
      return false;
    }
  });
}

// Whether the card should offer the step: Cursor's CLI is on this computer
// (commandFound(name) → 'native' | 'wsl' | null, from the last probe) and no
// folder has FULI approved yet. Once the person has approved it somewhere they
// know the question, and the card stops repeating it.
export async function cursorFirstRunPending({ commandFound, homeDir }) {
  return await commandFound(PROGRAM) === 'native' && !fuliApprovedSomewhere({ homeDir });
}

// Runs `cursor-agent mcp enable fuli` in `folder` and says honestly how it went:
// approved, not_installed, no_answer (it did not finish in time, most likely
// waiting on a first-run question), or failed with the CLI's own last line.
// locate(program): its absolute path (cli-presence.js). run: replaceable in tests.
export async function approveFuliInFolder(folder, { locate, run = runBounded, timeoutMs = ANSWER_WITHIN_MS } = {}) {
  const program = await locate(PROGRAM);
  if (!program) return { status: 'not_installed', command: CURSOR_APPROVE_COMMAND, folder };
  const outcome = await run(program, ARGS, { cwd: folder, timeoutMs });
  const said = lastLine(outcome.output);
  if (outcome.timedOut) return { status: 'no_answer', command: CURSOR_APPROVE_COMMAND, folder, waitedMs: timeoutMs };
  if (outcome.code === 0) return { status: 'approved', command: CURSOR_APPROVE_COMMAND, folder, ...(said ? { output: said } : {}) };
  return { status: 'failed', command: CURSOR_APPROVE_COMMAND, folder, ...(said ? { output: said } : {}) };
}

// The CLI's last line, without terminal colour codes, bounded.
function lastLine(output) {
  const plain = String(output ?? '').replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = plain.filter((text) => !/DeprecationWarning|trace-deprecation/.test(text)).at(-1) ?? '';
  return line.slice(0, MAX_OUTPUT);
}

function runBounded(program, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    execFile(program, args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        timedOut: Boolean(error?.killed && error.signal),
        output: `${stdout ?? ''}\n${stderr ?? ''}`
      }));
  });
}
