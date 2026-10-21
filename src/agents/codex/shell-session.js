const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The Codex session a shell command runs in, as Codex's lifecycle hooks name
// it. Codex gives the shell commands it starts (the person's `!` lines and the
// Agent's shell) CODEX_SESSION_ID, the root session its hooks send as
// session_id, and CODEX_THREAD_ID, the thread the command runs in. The two are
// equal in a top-level thread (new, forked or resumed) and differ in a
// sub-Agent thread (openai/codex 87f3c3284e16: codex-rs/core/src/session/
// session.rs 940-979, exec_env.rs 41-42, tasks/user_shell.rs 170-171,
// hook_runtime.rs 684-685). A sub-Agent's shell must not switch the
// conversation it works for, and missing values prove nothing, so both
// refuse: { sessionId } or { refused }.
export function codexShellSession(env) {
  const session = uuid(env?.CODEX_SESSION_ID), thread = uuid(env?.CODEX_THREAD_ID);
  if (!session && !thread) return null;
  if (!session || !thread) return { refused: 'codex_session_unproven' };
  return session === thread ? { sessionId: session } : { refused: 'codex_sub_agent_thread' };
}

function uuid(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return UUID.test(text) ? text : null;
}
