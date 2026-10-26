import { homedir } from 'node:os';
import { join } from 'node:path';
import { locateCodexSession } from './codex/token-usage.js';
import { codexPreferenceEvidence } from './codex/preference-evidence.js';
import { claudePreferenceEvidence } from './claude-code/preference-evidence.js';
import { locateClaudeSession } from './claude-code/session-file.js';

const claudeTranscript = async (sessionId, { env, transcriptPath }) => ({
  path: transcriptPath ?? await locateClaudeSession(sessionId,
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')),
  adapter: claudePreferenceEvidence
});

// Native format and discovery belong to the client adapter, not task policy.
const ADAPTERS = Object.freeze({
  codex: async (sessionId, { env, transcriptPath }) => ({
    path: transcriptPath ?? await locateCodexSession(sessionId,
      join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')),
    adapter: codexPreferenceEvidence
  }),
  claude_code: claudeTranscript,
  claude: claudeTranscript
});

export async function locatePreferenceTranscript(source, sessionId, options) {
  const result = await ADAPTERS[source]?.(sessionId, options);
  return result?.path ? result : null;
}
