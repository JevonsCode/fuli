import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Claude Code submits its own background-task notifications through the
// UserPromptSubmit hook. They continue the current user task rather than
// starting one, so they must not open a new Fuli task or repeat its context.
const HOST_NOTIFICATION = /^\s*<task-notification>\s*<task-id>/;
const TAIL_BYTES = 512 * 1024;

export function looksLikeHostNotification(prompt) {
  return typeof prompt === 'string' && HOST_NOTIFICATION.test(prompt);
}

// The prompt text alone could be pasted by a user. Claude records each host
// notification as a queued_command attachment with commandMode
// task-notification before the hook runs; require that exact record.
export function isHostNotificationEntry(input, { readTail = readTranscriptTail } = {}) {
  if (!looksLikeHostNotification(input?.prompt) || !input.transcript_path) return false;
  let tail;
  try { tail = readTail(input.transcript_path); } catch { return false; }
  return tail.split('\n').some((line) => {
    if (!line.includes('"queued_command"')) return false;
    try {
      const record = JSON.parse(line);
      return record?.sessionId === input.session_id
        && record.attachment?.type === 'queued_command'
        && record.attachment.commandMode === 'task-notification'
        && record.attachment.prompt === input.prompt;
    } catch {
      return false;
    }
  });
}

export function hostNotificationOutput(event) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext:
    'Fuli: host background-task notification, not a new user task. Keep the current task context and its '
    + 'taskContextToken; no new task entry or fallback call is needed.' } };
}

function readTranscriptTail(path) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}
