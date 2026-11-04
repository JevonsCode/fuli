import { randomUUID } from 'node:crypto';

import { redactSensitiveContent } from '../security/sensitive-content.js';

// One #fulidebug turn as a person reads it (Jevons 11-04): ordered parts, each
// with who put it there. FULI's own additions (its hook frames, MCP surface
// and tool calls) are `fuli`, so the console can show them apart.
export const DEBUG_PART_SOURCES = Object.freeze(['person', 'fuli', 'ai', 'host', 'not_visible']);
export const DEBUG_RECORD_VERSION = 1;
export const DEBUG_RECORD_MAX_BYTES = 2 * 1024 * 1024;

// FULI's MCP server is registered as "fuli"; both hosts name its tools mcp__fuli__<tool>.
const FULI_TOOL = /^mcp__fuli(?:__|\.)/;
// A task token is the key to the task's checkpoint; the record never keeps one.
// Only a value is masked, quoted (also inside escaped JSON) or bare, never a schema's `{`.
const TASK_TOKEN_FIELD = /(\\?"?task_?context_?token\\?"?\s*[:=]\s*)(\\?")?[^"\\\s,{}[\]]+/gi;
const TASK_TOKEN_VALUE = /\bfuli-task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PROMPT_LINE_CHARS = 200;

const NOT_VISIBLE = 'FULI 看不到客户端自己的系统提示词和工具定义，所以这里是 FULI 能看到的全部内容，不是逐字节的模型输入。 '
  + 'FULI cannot see the client\'s own system prompt and tool definitions, so this is everything FULI can see, '
  + 'not a byte-exact model input.';
const NO_TRANSCRIPT = Object.freeze({
  unavailable: 'FULI 没有读到这个会话的记录文件，所以没有 AI 的回复、其他工具调用和历史对话。 '
    + 'FULI could not read this session\'s transcript, so the assistant\'s messages, other tool calls and the history are missing.',
  not_supported: '这个客户端不给 FULI 会话记录，所以没有 AI 的回复、其他工具调用和历史对话。 '
    + 'This client gives FULI no transcript, so the assistant\'s messages, other tool calls and the history are missing.'
});

export function redactDebugText(text) {
  return redactSensitiveContent(text)
    .replace(TASK_TOKEN_FIELD, '$1$2[redacted:task_context_token]')
    .replace(TASK_TOKEN_VALUE, '[redacted:task_context_token]');
}

// turn: { sourceApplication, sessionId, prompt, frames: [{ event, text }],
// surface: { instructions, tools } | null, transcript: { status, history,
// historyComplete, events } (normalized events, transcript-reader.js), and
// lastAssistantMessage from the Stop input }. Every text is redacted here.
export function buildDebugRecord(turn, { now = () => new Date(), id = randomUUID() } = {}) {
  const { transcript } = turn;
  const parts = [part('not_visible', 'system_prompt', '', NOT_VISIBLE)];
  if (transcript.status !== 'read') parts.push(part('not_visible', 'no_transcript', '', NO_TRANSCRIPT[transcript.status]));
  if (turn.surface) {
    parts.push(part('fuli', 'mcp_instructions', '', turn.surface.instructions));
    parts.push(part('fuli', 'mcp_tools', String(turn.surface.tools.length), JSON.stringify(turn.surface.tools, null, 2)));
  }
  const history = transcript.status === 'read' ? historyPart(transcript.history, transcript.historyComplete) : null;
  if (history) parts.push(history.part);
  parts.push(part('person', 'prompt', '', turn.prompt));
  const [entry, ...later] = turn.frames;
  if (entry) parts.push(part('fuli', 'hook_frame', entry.event, entry.text));
  const events = turnParts(transcript.events ?? []);
  parts.push(...events);
  const last = turn.lastAssistantMessage;
  if (typeof last === 'string' && last && events.findLast((item) => item.source === 'ai')?.text !== redactDebugText(last)) {
    parts.push(part('ai', 'assistant_message', '', last));
  }
  for (const frame of later) parts.push(part('fuli', 'hook_frame', frame.event, frame.text));
  const record = {
    version: DEBUG_RECORD_VERSION, id, createdAt: now().toISOString(), sourceApplication: turn.sourceApplication,
    sessionId: turn.sessionId, promptLine: promptLine(parts.find((item) => item.source === 'person').text),
    transcript: transcript.status, parts, totals: null, cut: null
  };
  return withTotals(withinCap(record, history));
}

// One model request from the dev capture proxy (model-capture.js): the
// whole request, so nothing here is out of sight. `parts` come in reading order.
export function buildModelRequestRecord({ sourceApplication, prompt, parts }, { now = () => new Date(), id = randomUUID() } = {}) {
  const record = { version: DEBUG_RECORD_VERSION, id, createdAt: now().toISOString(), sourceApplication, sessionId: 'model-capture',
    promptLine: promptLine(redactDebugText(prompt)), transcript: 'read',
    parts: parts.map(item => part(item.source, item.kind, item.label ?? '', item.text)), totals: null, cut: null };
  return withTotals(withinCap(record, null));
}

function part(source, kind, label, text) {
  const stored = redactDebugText(String(text ?? ''));
  return { source, kind, label, text: stored, bytes: Buffer.byteLength(stored) };
}

function promptLine(prompt) {
  const line = prompt.split(/\r?\n/, 1)[0];
  return line.length > PROMPT_LINE_CHARS ? `${line.slice(0, PROMPT_LINE_CHARS)}…` : line;
}

// The conversation since the last compaction, as one part: a line per message.
function historyPart(events, complete) {
  const lines = events.map((event) => `[${event.kind === 'message' ? event.role : event.kind}] ${redactDebugText(event.content)}`);
  const text = lines.join('\n');
  return { lines, complete, part: { source: 'host', kind: 'history', label: String(lines.length), messages: lines.length,
    complete, text, bytes: Buffer.byteLength(text) } };
}

// The turn's own transcript events: the assistant's words are `ai`; a call
// to a FULI tool and its result are `fuli`; every other call and result is `host`.
function turnParts(events) {
  const calls = new Map();
  return events.flatMap((event) => {
    if (event.kind === 'message') {
      return [part(event.role === 'assistant' ? 'ai' : 'host', event.role === 'assistant' ? 'assistant_message' : 'user_message',
        '', event.content)];
    }
    if (event.kind === 'tool_call') {
      const call = parsed(event.content);
      const source = FULI_TOOL.test(call?.name ?? '') ? 'fuli' : 'host';
      if (call?.call_id) calls.set(call.call_id, { source, name: call.name ?? '' });
      return [part(source, 'tool_call', call?.name ?? '', event.content)];
    }
    if (event.kind === 'tool_result') {
      const call = calls.get(parsed(event.content)?.call_id) ?? { source: 'host', name: '' };
      return [part(call.source, 'tool_result', call.name, event.content)];
    }
    return [part('host', event.kind, '', event.content)];
  });
}

function parsed(content) {
  try { return JSON.parse(content); } catch { return null; }
}

const recordBytes = (record) => Buffer.byteLength(JSON.stringify(record));

// At most DEBUG_RECORD_MAX_BYTES: the oldest history goes first, and the
// history says how much was cut. Only a turn too big even without its
// history has its largest parts shortened, each marked where it was cut.
function withinCap(record, history) {
  if (recordBytes(record) <= DEBUG_RECORD_MAX_BYTES) return record;
  let parts = record.parts;
  let cut = null;
  if (history) {
    const index = parts.indexOf(history.part);
    const shown = { ...history.part, text: '' };
    const room = DEBUG_RECORD_MAX_BYTES - recordBytes({ ...record, parts: parts.with(index, shown), cut: CUT_SHAPE });
    const kept = [];
    let used = 0;
    for (let at = history.lines.length - 1; at >= 0; at -= 1) {
      const size = Buffer.byteLength(JSON.stringify(history.lines[at])) + 1;
      if (used + size > room - CUT_NOTE_ROOM) break;
      kept.unshift(history.lines[at]);
      used += size;
    }
    const dropped = history.lines.length - kept.length;
    const droppedBytes = history.part.bytes - Buffer.byteLength(kept.join('\n'));
    cut = { historyMessages: dropped, historyBytes: droppedBytes, parts: [] };
    const note = `[${dropped} earlier messages (${droppedBytes} bytes) were cut to keep this record under 2 MB]`;
    parts = parts.with(index, { ...history.part, text: [note, ...kept].join('\n') });
  }
  const capped = { ...record, parts, cut: cut ?? { historyMessages: 0, historyBytes: 0, parts: [] } };
  return recordBytes(capped) <= DEBUG_RECORD_MAX_BYTES ? capped : shortenLargest(capped);
}

const CUT_SHAPE = Object.freeze({ historyMessages: Number.MAX_SAFE_INTEGER, historyBytes: Number.MAX_SAFE_INTEGER, parts: [] });
const CUT_NOTE_ROOM = 256;
const SHORTENED = '\n[…cut to keep this record under 2 MB]';

function shortenLargest(record) {
  const parts = [...record.parts];
  const shortened = [];
  while (recordBytes({ ...record, parts }) > DEBUG_RECORD_MAX_BYTES) {
    const index = parts.reduce((largest, item, at) => (item.text.length > parts[largest].text.length ? at : largest), 0);
    const over = recordBytes({ ...record, parts }) - DEBUG_RECORD_MAX_BYTES;
    const target = parts[index];
    const keep = Math.max(0, Buffer.byteLength(target.text) - over - SHORTENED.length * 2 - 1024);
    // A cut inside a code point leaves U+FFFD at the end; drop it.
    const text = Buffer.from(target.text).subarray(0, keep).toString('utf8').replace(/\uFFFD+$/, '') + SHORTENED;
    parts[index] = { ...target, text };
    if (!shortened.includes(index)) shortened.push(index);
  }
  return { ...record, parts, cut: { ...record.cut, parts: shortened.sort((a, b) => a - b) } };
}

// Bytes per source, from what FULI saw (a cut history counts as it was).
function withTotals(record) {
  const totals = Object.fromEntries(DEBUG_PART_SOURCES.map((source) => [source, 0]));
  for (const item of record.parts) totals[item.source] += item.bytes;
  return { ...record, totals };
}
