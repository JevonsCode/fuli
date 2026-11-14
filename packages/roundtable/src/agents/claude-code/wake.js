import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { firstField, listDirectory } from '../session-log.js';

// A read-only wake has only the built-in tools that read. Whatever edits a file, runs a command
// (Bash, PowerShell), fetches from the web or starts another agent is not there; the edit and
// shell tools are denied as well, since a deny rule wins over any allow rule the person keeps.
// Tools of MCP servers the person configured are not built in: a wake given mcpServers (an ask
// from another computer) loads exactly those (--strict-mcp-config), FULI's own or none; other
// read-only wakes still follow that person's own allow rules (docs/agent-roundtable.md).
const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
const READ_ONLY_DENIED_TOOLS = Object.freeze(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'PowerShell']);
const MODE_ARGUMENTS = Object.freeze({
  answer: ['--permission-mode', 'dontAsk'],
  read_only: ['--permission-mode', 'dontAsk', '--tools', READ_ONLY_TOOLS.join(','), '--disallowedTools', READ_ONLY_DENIED_TOOLS.join(',')],
});

// Wakes Claude Code headlessly. Resuming forks the session, so an open window is
// never written concurrently while the answer still has that conversation's context.
export const claudeCodeWake = Object.freeze({
  id: 'claude_code',

  resolveCommand({ env, which, platform }) {
    return env.FULI_CLAUDE_BIN || which('claude', platform);
  },

  // Claude Code reports its session only after the prompt hook has run, so a
  // delegated wake names the (forked) session up front and binds it first.
  plansSession: true,

  // mode (roundtable/wake.js WAKE_MODES): answer keeps the person's own rules;
  // read_only (a group discussion turn, an ask from another computer) keeps the
  // same non-interactive mode with the reading tools only, so the woken session
  // can read and answer but not change files or run commands. (Plan mode is
  // avoided: headless it may end with a plan or an empty answer instead of the
  // member's view.) mcpServers ({ name: { command, args } }, possibly empty): a
  // read_only wake then loads exactly these MCP servers, none of the person's.
  args({ sessionId, plannedSessionId = null, mode, mcpServers = null }) {
    const only = mcpServers && mode === 'read_only' ? ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers:
      Object.fromEntries(Object.entries(mcpServers).map(([name, entry]) => [name, { type: 'stdio', command: entry.command, args: entry.args }])) })] : [];
    return ['-p', '--output-format', 'stream-json', '--verbose', ...MODE_ARGUMENTS[mode], ...only,
      ...(sessionId ? ['--resume', sessionId, '--fork-session'] : []),
      ...(plannedSessionId ? ['--session-id', plannedSessionId] : [])];
  },

  // A session resumes only from the directory it started in.
  sessionDirectory(sessionId, { home }) {
    const root = join(home, '.claude', 'projects');
    for (const project of listDirectory(root)) {
      const file = join(root, project, `${sessionId}.jsonl`);
      if (existsSync(file)) return firstField(file, (line) => line.cwd);
    }
    return null;
  },

  // stream-json ends with one `result` event carrying the final answer. Its
  // `system` `init` event names the model the session runs (rec#129).
  initialState: () => ({ body: '', completed: true, failed: false, model: null }),
  nativeSessionId: event => event.type === 'system' && event.subtype === 'init' ? event.session_id : null,
  readEvent(event, state) {
    if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') state.model = event.model;
    if (event.type !== 'result') return;
    state.body = event.result ?? '';
    state.failed ||= Boolean(event.is_error);
  },
});
