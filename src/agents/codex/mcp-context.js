import { ApplicationError } from '../../app/application-error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Codex supplies these outside model arguments on every local MCP request.
// threadId is the persistent chat; sessionId/windowId identify its execution
// and active context. Unknown fields never substitute a caller-guessed ID.
export function codexMcpRequestContext(meta) {
  if (!meta || !['threadId', 'sessionId', 'windowId'].some(key => Object.hasOwn(meta, key))) return null;
  if (typeof meta?.threadId !== 'string' || typeof meta?.sessionId !== 'string'
      || !UUID.test(meta.threadId) || !UUID.test(meta.sessionId)
      || (meta.windowId != null && (typeof meta.windowId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(meta.windowId)))) {
    throw new ApplicationError('validation', 'Codex native request identity is unavailable; do not reuse an older session.');
  }
  return { nativeSessionId: meta.threadId, nativeExecutionId: meta.sessionId, contextWindowId: meta.windowId ?? null };
}
