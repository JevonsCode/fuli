import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const HOST_NOTIFICATION = /^\s*<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>([\s\S]*)<\/task-notification>\s*$/;
const TAIL_BYTES = 512 * 1024;

// Shape alone is never provenance: the same envelope can be pasted by a user.
export function looksLikeHostNotification(prompt) {
  const match = typeof prompt === 'string' && HOST_NOTIFICATION.exec(prompt);
  return Boolean(match && match[1].trim() && !/<\/?task-notification>/.test(match[2]));
}

// Claude queues a background notification before UserPromptSubmit and removes
// it after delivery. Only a pending, exact, main-session enqueue can continue
// the current task. A queued user command always takes precedence for that enqueue.
export function isHostNotificationEntry(input, { readTail = readTranscriptTail } = {}) {
  if (!looksLikeHostNotification(input?.prompt)
      || typeof input.session_id !== 'string' || !input.session_id.trim() || input.session_id.length > 256
      || typeof input.cwd !== 'string' || !input.cwd.trim()
      || typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return false;
  try {
    let pending = false;
    let userCommand = false;
    for (const line of readTail(input.transcript_path).split('\n')) {
      if (!line.trim()) continue;
      // Invalid records could hide a removal or user command; do not skip a task.
      const record = JSON.parse(line);
      if (record?.sessionId !== input.session_id
          || (record.isSidechain != null && record.isSidechain !== false)) continue;
      if (record.type === 'queue-operation' && record.content === input.prompt) {
        const enqueued = record.operation === 'enqueue';
        if (!enqueued || !pending) userCommand = false;
        pending = enqueued;
      } else if (record.type === 'queue-operation' && record.operation !== 'enqueue'
          && typeof record.content !== 'string') {
        // A removal without a payload cannot prove that this enqueue survived.
        pending = false;
      } else if (pending && record.attachment?.type === 'queued_command'
          && record.attachment.prompt === input.prompt && record.attachment.commandMode != null
          && record.attachment.commandMode !== 'task-notification') {
        userCommand = true;
      }
    }
    return pending && !userCommand;
  } catch { return false; }
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
    if (readSync(descriptor, buffer, 0, length, size - length) !== length) return '';
    // A suffix beginning inside a JSON string can itself look like a whole
    // enqueue record. Discard the cut line before parsing or decoding UTF-8.
    const cut = size > length ? buffer.indexOf(10) : -1;
    if (size > length && cut === -1) return '';
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(cut + 1));
  } finally { closeSync(descriptor); }
}
