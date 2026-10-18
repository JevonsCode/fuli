// Only explicit host metadata can identify a system delivery. A user can
// paste notification/XML envelopes, so prompt text alone never bypasses entry.
export function isSystemPromptEntry(input) {
  return input?.isMeta === true || input?.is_meta === true;
}

export function systemPromptOutput(event) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Fuli: host system notification, not a new user task. Keep the current task context and its '
    + 'taskContextToken; no new task entry or fallback call is needed.' } };
}
