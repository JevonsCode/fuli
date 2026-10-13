import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Claude Code submits its own background-task notifications through the
// UserPromptSubmit hook. They continue the current user task rather than
// starting one, so they must not open a new Fuli task or repeat its context.
const HOST_NOTIFICATION = /^\s*<task-notification>\s*<task-id>/;
const TAIL_BYTES = 512 * 1024;

export function looksLikeHostNotification(prompt) {
  return typeof prompt === 'string' && HOST_NOTIFICATION.test(prompt);
}

// Prompt text alone could be pasted by a user. Claude writes a queue-operation
// enqueue record for the exact prompt before running the hook and its remove
// record afterwards, so only a still-pending enqueue identifies this delivery.
// A queued_command attachment that labels it a user prompt overrides the shape.
export function isHostNotificationEntry(input, { readTail = readTranscriptTail } = {}) {
  if (!looksLikeHostNotification(input?.prompt) || !input.transcript_path) return false;
  let tail;
  try { tail = readTail(input.transcript_path); } catch { return false; }
  let pending = false;
  let mode = null;
  for (const line of tail.split('\n')) {
    if (!line.includes('queue')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.sessionId !== input.session_id) continue;
    if (record.type === 'queue-operation' && record.content === input.prompt) {
      if (record.operation === 'enqueue') { pending = true; mode = null; }
      else pending = false;
    } else if (pending && record.attachment?.type === 'queued_command' && record.attachment.prompt === input.prompt) {
      mode = record.attachment.commandMode ?? null;
    }
  }
  return pending && (mode === null || mode === 'task-notification');
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
