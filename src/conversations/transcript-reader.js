import { open, constants } from 'node:fs/promises';
import { transcriptDigest } from './transcript-guard.js';
import { safeConversationContent } from '../graphiti/agent-conversations.js';

const WINDOW = 512 * 1024;
// Start capture at this task, never import an existing file's unrelated past.
// Read only a bounded tail; a prompt not yet written by the host starts at EOF.
export async function initialTranscriptBoundary(path, sessionId, prompt, adapter) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(Math.min(WINDOW, size));
    await file.read(header, 0, header.length, 0);
    const firstEnd = header.indexOf(10);
    if (firstEnd < 0 || !adapter.verify(JSON.parse(header.subarray(0, firstEnd).toString()), sessionId)) {
      throw new Error('Transcript identity is unavailable');
    }
    const start = Math.max(0, size - WINDOW);
    const tail = Buffer.alloc(size - start);
    await file.read(tail, 0, tail.length, start);
    if (tail.at(-1) !== 10) throw new Error('Wait for the host to finish the transcript record');
    let offset = start ? tail.indexOf(10) + 1 : 0;
    let boundary = size;
    while (offset < tail.length) {
      const end = tail.indexOf(10, offset);
      if (end < 0) break;
      const raw = tail.subarray(offset, end).toString('utf8').trim();
      if (raw && adapter.normalize(JSON.parse(raw), sessionId).some(event =>
        event.role === 'user' && event.kind === 'message' && event.content === prompt)) boundary = start + offset;
      offset = end + 1;
    }
    return boundary;
  } finally { await file.close(); }
}
// The hook supplies the exact current transcript. No directory scanning, native
// transcript writes, or path/session metadata is persisted in conversation events.
export async function readTranscriptBatch(path, sessionId, cursor, adapter, { stopBeforePrompt = null, stopBeforeDigest = null, stopAtCursor = null } = {}) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || cursor > stat.size) throw new Error('Transcript changed or is unavailable');
    const header = Buffer.alloc(Math.min(WINDOW, stat.size));
    await file.read(header, 0, header.length, 0);
    const firstEnd = header.indexOf(10);
    if (firstEnd < 0 || !adapter.verify(JSON.parse(header.subarray(0, firstEnd).toString()), sessionId)) {
      throw new Error('Transcript session or format could not be verified');
    }
    const endCursor = stopAtCursor === null ? stat.size : Math.min(stat.size, stopAtCursor);
    if (endCursor < cursor) throw new Error('Transcript boundary precedes cursor');
    const buffer = Buffer.alloc(Math.min(WINDOW, endCursor - cursor));
    await file.read(buffer, 0, buffer.length, cursor);
    const events = [];
    let end = 0;
    let payloadBytes = 0;
    let omitted = false;
    let userMessages = 0;
    let uncertainFrom = null;
    // A cursor inside an oversized native line is a durable continuation: the
    // preceding byte proves that parsing must wait until the next newline.
    const previous = Buffer.alloc(1);
    if (cursor) await file.read(previous, 0, 1, cursor - 1);
    const omission = offset => ({ event_id: `jsonl-v1:${offset}:omitted`,
      role: 'tool', kind: 'tool_result',
      content: '[Visible transcript content omitted: record exceeds capture bounds; original remains in native history.]' });
    if (cursor && previous[0] !== 10) {
      const newline = buffer.indexOf(10);
      end = newline < 0 ? buffer.length : newline + 1;
      if (end) { events.push(omission(cursor)); payloadBytes = Buffer.byteLength(events[0].content); omitted = true; uncertainFrom = cursor; }
    }
    while (end < buffer.length) {
      const newline = buffer.indexOf(10, end);
      if (newline < 0) {
        // Preserve ordinary unfinished writes. For an oversized line, commit a
        // bounded omission fragment so the next hook can resume without RAM or
        // cursor growth being tied to the native record's unbounded size.
        if (end === 0 && buffer.length === WINDOW) {
          events.push(omission(cursor)); omitted = true; uncertainFrom ??= cursor; end = buffer.length;
        }
        break;
      }
      const raw = buffer.subarray(end, newline).toString('utf8').trim();
      const normalized = raw ? adapter.normalize(JSON.parse(raw), sessionId) : [];
      if ((stopBeforePrompt !== null || stopBeforeDigest) && normalized.some(event => event.role === 'user' && event.kind === 'message' && (stopBeforeDigest ? transcriptDigest(event.content) === stopBeforeDigest : event.content === stopBeforePrompt))) {
        return { events, cursor: cursor + end, promptEndCursor: cursor + newline + 1, hasMore: false, atPromptBoundary: true, userMessages, omitted, uncertainFrom };
      }
      const users = normalized.filter(event => event.role === 'user' && event.kind === 'message').length;
      userMessages += users;
      if (users) uncertainFrom ??= cursor + end;
      let rowEvents = normalized.flatMap((event, index) => {
        const content = safeConversationContent(event.content);
        const chunks = [];
        // Slice by code points to preserve Unicode; each chunk <= 128 KiB UTF-8.
        const points = Array.from(content);
        for (let offset = 0; offset < points.length; offset += 16000) {
          chunks.push({ ...event, event_id: `jsonl-v1:${cursor + end}:${index}:${offset}`,
            content: points.slice(offset, offset + 16000).join('') });
        }
        return chunks;
      });
      let bytes = rowEvents.reduce((sum, event) => sum + Buffer.byteLength(event.content), 0);
      if (rowEvents.length > 50 || bytes > WINDOW) {
        rowEvents = [omission(cursor + end)];
        bytes = Buffer.byteLength(rowEvents[0].content);
        omitted = true;
        uncertainFrom ??= cursor + end;
      }
      if (events.length + rowEvents.length > 50 || payloadBytes + bytes > 512 * 1024) break;
      events.push(...rowEvents); payloadBytes += bytes;
      end = newline + 1;
    }
    return { events, cursor: cursor + end, hasMore: cursor + end < endCursor, userMessages, omitted, uncertainFrom, completeRecord: cursor + end === 0 || (end ? buffer[end - 1] === 10 : previous[0] === 10) };
  } finally { await file.close(); }
}
