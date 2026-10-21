import { claudeCodeNativeSessionId } from './claude-code/native-session.js';
import { nativeCodexThreadId } from '../mcp/session-id.js';
import { codexShellSession } from './codex/shell-session.js';

const READERS = Object.freeze({ codex: nativeCodexThreadId, claude_code: claudeCodeNativeSessionId });

// The host's own session ID from the environment it gave this MCP process,
// read only for the client the process was started for.
export function nativeSessionFromEnv(sourceApplication, env = process.env) {
  return READERS[sourceApplication]?.(env) ?? null;
}

// The session of a shell command the client started, as its prompt hooks name
// it: { sessionId }, { refused } when the environment cannot prove it, or null
// when the client names none. Claude Code updates its value on /clear.
const SHELL_READERS = Object.freeze({
  claude_code: env => { const sessionId = claudeCodeNativeSessionId(env); return sessionId ? { sessionId } : null; },
  codex: codexShellSession
});

export function shellSessionFromEnv(sourceApplication, env = process.env) {
  return SHELL_READERS[sourceApplication]?.(env) ?? null;
}
