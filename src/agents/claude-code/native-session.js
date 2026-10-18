const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code exports the running session's ID to the processes it starts,
// including stdio MCP servers. The model cannot set it, so it is host
// provenance like Codex's CODEX_THREAD_ID; anything that is not a UUID is ignored.
export function claudeCodeNativeSessionId(env = process.env) {
  const value = typeof env?.CLAUDE_CODE_SESSION_ID === 'string' ? env.CLAUDE_CODE_SESSION_ID.trim() : '';
  return UUID.test(value) ? value : null;
}
