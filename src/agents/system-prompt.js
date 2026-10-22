// A prompt hook input marked isMeta or is_meta. A user can paste
// notification/XML envelopes, so prompt text alone is never such a mark. What
// the mark proves depends on the host: each Agent's hook decides (Claude Code
// host-notification.js, Codex lifecycle-hook.js), and neither trusts it to
// continue a task.
export function isSystemPromptEntry(input) {
  return input?.isMeta === true || input?.is_meta === true;
}
