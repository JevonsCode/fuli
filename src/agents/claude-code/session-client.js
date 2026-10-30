import { dirname } from 'node:path';

import { sessionClientRecords } from '../../agent-kits/session-clients.js';

// Claude Code tells its hooks how it was started in CLAUDE_CODE_ENTRYPOINT:
// `cli` in a terminal, `claude-desktop` in Claude Desktop's Code tab, others
// for the IDE extensions and SDKs. It is not secret. Without it Claude
// Desktop and the CLI look the same to FULI (rec#11 D-79).
const ENTRYPOINT = 'CLAUDE_CODE_ENTRYPOINT';

// The source label and entry point the session launcher classifies later. The
// launcher refines a Claude source only to Claude Desktop, so a terminal
// session is named for what it is; any other entry point stays the ambiguous
// "Claude Code" (no guess between IDE, SDK and CLI).
function claudeSessionSource(env) {
  const entrypoint = typeof env[ENTRYPOINT] === 'string' && env[ENTRYPOINT].trim() ? env[ENTRYPOINT].trim() : null;
  return { source: entrypoint === 'cli' ? 'Claude Code CLI' : 'Claude Code', entrypoint };
}

// Records once per session how the session was started: a file read and at
// most one small write, never a process or a wait on the prompt path. The
// console classifies the client when it needs it (session-offers.js) and
// keeps the answer in the same record. runtimeConfigPath sits in the data
// directory.
export function recordClaudeSessionClient({ runtimeConfigPath, sessionId, env = process.env }) {
  const records = sessionClientRecords(dirname(runtimeConfigPath));
  if (records.read('claude_code', sessionId)) return;
  records.record('claude_code', sessionId, claudeSessionSource(env));
}
