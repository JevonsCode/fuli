// Claude Code submits its own background-task notifications through the
// UserPromptSubmit hook. They continue the current user task rather than
// starting one, so they must not open a new Fuli task or repeat its context.
const HOST_NOTIFICATION = /^\s*<task-notification>\s*<task-id>/;

export function isHostNotificationPrompt(prompt) {
  return typeof prompt === 'string' && HOST_NOTIFICATION.test(prompt);
}

export function hostNotificationOutput(event) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Fuli: host background-task notification, not a new user task. Keep the current task context and its '
    + 'taskContextToken; no new task entry or fallback call is needed.' } };
}
