import { dirname } from 'node:path';

import { agentKitPorts } from '../../agent-kits/ports.js';
import { sessionClientRecords } from '../../agent-kits/session-clients.js';
import { resolveSetupPaths } from '../../setup/paths.js';

// Claude Code tells its hooks how it was started in CLAUDE_CODE_ENTRYPOINT:
// `cli` in a terminal, `claude-desktop` in Claude Desktop's Code tab, others
// for the IDE extensions and SDKs. It is not secret. Without it Claude
// Desktop and the CLI look the same to FULI (rec#11 D-79).
const ENTRYPOINT = 'CLAUDE_CODE_ENTRYPOINT';
// A hook answers within its budget: a launcher that does not answer quickly
// leaves the session to be classified later by the console.
const CLASSIFY_TIMEOUT_MS = 2000;

// The source label and entry point the session launcher classifies. The
// launcher refines a Claude source only to Claude Desktop, so a terminal
// session is named for what it is; any other entry point stays the ambiguous
// "Claude Code" (no guess between IDE, SDK and CLI).
function claudeSessionSource(env) {
  const entrypoint = typeof env[ENTRYPOINT] === 'string' && env[ENTRYPOINT].trim() ? env[ENTRYPOINT].trim() : null;
  return { source: entrypoint === 'cli' ? 'Claude Code CLI' : 'Claude Code', entrypoint };
}

// Records once per session which client it runs in. A hook never downloads
// the launcher: without one the label and entry point are kept and the
// console classifies them later. runtimeConfigPath sits in the data directory.
export async function recordClaudeSessionClient({ runtimeConfigPath, sessionId, env = process.env, launcher }) {
  const paths = resolveSetupPaths({ dataDir: dirname(runtimeConfigPath), env });
  const records = sessionClientRecords(paths.dataDir);
  if (records.read('claude_code', sessionId)) return;
  const { source, entrypoint } = claudeSessionSource(env);
  const answer = await (launcher ?? agentKitPorts(paths, { env, launcherTimeoutMs: CLASSIFY_TIMEOUT_MS }).sessionLauncher)
    .classify(source, { claudeEntrypoint: entrypoint ?? undefined });
  records.record('claude_code', sessionId, { client: answer.status === 'available' ? answer.client : null,
    source, entrypoint });
}
