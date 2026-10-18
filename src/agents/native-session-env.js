import { claudeCodeNativeSessionId } from './claude-code/native-session.js';
import { nativeCodexThreadId } from '../mcp/session-id.js';

const READERS = Object.freeze({ codex: nativeCodexThreadId, claude_code: claudeCodeNativeSessionId });

// The host's own session ID from the environment it gave this MCP process,
// read only for the client the process was started for.
export function nativeSessionFromEnv(sourceApplication, env = process.env) {
  return READERS[sourceApplication]?.(env) ?? null;
}
