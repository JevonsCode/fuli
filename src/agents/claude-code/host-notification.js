import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isSystemPromptEntry, systemPromptOutput } from '../system-prompt.js';

const HOST_NOTIFICATION = /^\s*<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>([\s\S]*)<\/task-notification>\s*$/;
// Claude Code task ids are short random tokens ("br4oz7ug3", "a441e10fe52fb946d").
const TASK_ID = /^[A-Za-z0-9_-]{6,64}$/;
const TAIL_BYTES = 512 * 1024;

// What the transcript holds when UserPromptSubmit runs (Claude Code transcripts, 2026-10):
// every queued turn, typed or host-started, is `enqueue {content}` then a `dequeue` without
// content, and the turn's own record (origin, promptSource) is written only after the hook
// returns. The queue alone therefore cannot tell a background-task notification (subagent,
// shell or Monitor event) from a person who pasted one. A notification continues the current
// task only when, in this main session's transcript:
// - its exact text was enqueued once and has not been delivered or absorbed: pasting a
//   delivered notification repeats that text;
// - its <task-id> names a background task this session started: the id is in an earlier tool
//   result, or in an earlier turn the host itself recorded as a task notification.
// `<ci-monitor-event>` turns from the desktop app arrive as ordinary prompts (queued command
// mode "prompt", no origin) and name no session-owned id, so they always get full task context.
export function isHostNotificationEntry(input, { readTail = readTranscriptTail } = {}) {
  if (isSystemPromptEntry(input)) return true;
  const taskId = notificationTaskId(input?.prompt);
  if (!taskId
      || typeof input.session_id !== 'string' || !input.session_id.trim() || input.session_id.length > 256
      || typeof input.cwd !== 'string' || !input.cwd.trim()
      || typeof input.transcript_path !== 'string' || !input.transcript_path.trim()) return false;
  try {
    const records = [];
    for (const line of readTail(input.transcript_path).split('\n')) {
      if (!line.trim()) continue;
      // Invalid records could hide a delivery or a user command; do not skip a task.
      const record = JSON.parse(line);
      if (record?.sessionId === input.session_id && (record.isSidechain == null || record.isSidechain === false)) {
        records.push(record);
      }
    }
    return pendingOnce(records, input.prompt) && ownsTask(records, input.prompt, taskId);
  } catch { return false; }
}

export const hostNotificationOutput = systemPromptOutput;

// Shape alone is never provenance: the same envelope can be pasted by a user.
function notificationTaskId(prompt) {
  const match = typeof prompt === 'string' && HOST_NOTIFICATION.exec(prompt);
  const taskId = match && match[1].trim();
  return taskId && TASK_ID.test(taskId) && !/<\/?task-notification>/.test(match[2]) ? taskId : null;
}

function pendingOnce(records, prompt) {
  let enqueued = 0;
  let pending = false;
  for (const record of records) {
    // The host dequeues the turn it is starting now; any other removal ends the enqueue.
    if (record.type === 'queue-operation' && record.operation !== 'dequeue') {
      if (record.content === prompt) {
        if (record.operation === 'enqueue') enqueued += 1;
        pending = record.operation === 'enqueue';
      } else if (typeof record.content !== 'string' && record.operation !== 'enqueue') {
        // A removal without a payload cannot prove that this enqueue survived.
        pending = false;
      }
    } else if (record.type === 'attachment' && record.attachment?.type === 'queued_command'
        && record.attachment.prompt === prompt) {
      // Delivered inside a turn already, or queued by a person.
      return false;
    } else if (record.type === 'user' && messageText(record.message) === prompt) {
      return false;
    }
  }
  return enqueued === 1 && pending;
}

function ownsTask(records, prompt, taskId) {
  const named = new RegExp(`(?:^|[^A-Za-z0-9_-])${taskId}(?:$|[^A-Za-z0-9_-])`);
  for (const record of records) {
    if (record.type === 'queue-operation' && record.content === prompt) return false;
    if (record.type !== 'user') continue;
    if (record.origin?.kind === 'task-notification' && notificationTaskId(messageText(record.message)) === taskId) return true;
    if (Array.isArray(record.message?.content) && record.message.content.some(part =>
      part?.type === 'tool_result' && named.test(partText(part.content)))) return true;
  }
  return false;
}

function messageText(message) {
  return typeof message?.content === 'string' ? message.content : partText(message?.content);
}

function partText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '';
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
