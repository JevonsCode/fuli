import { constants } from 'node:fs';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { preferenceAuthorityView } from '../mcp/preference-delivery.js';
import { conversationResultRecovery } from './recent-context.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FIRST_RECORD_BYTES = 1024 * 1024;
const DIRECT_TOOLS = /^(?:mcp__fuli__|mcp__fuli\.)(?:get_collaboration_preferences|begin_task_context|read_task_preferences|resume_agent_conversation|read_agent_conversation)$/;
const CODE_MODE = new Set(['functions.exec', 'functions.wait']);

// Inspect the native model-facing record, never Hook stdout, a log of writes,
// an assistant's claim, or a cache hit. Bounds/format uncertainty means full.
// since is where the current context generation starts (after the last reset
// record); records holds the complete native records that start at the
// requested byte offsets, as parsed. A transcript over MAX_BYTES is read from
// its last reset in the final MAX_BYTES (rec#15: a long session otherwise got
// a full context on every turn).
export async function readPreferenceEvidence(path, sessionId, adapter, recordOffsets = new Set()) {
  let file;
  try {
    file = await openWithoutFollowing(path, constants.O_RDONLY);
    // Exact file identity: a Windows file ID is a 64-bit number (MFT record and
    // sequence) that a Number rounds above 2^53, so a replaced file whose new ID
    // is next to the old one could read as the same file and keep confirming
    // what only the old one held (recent-context.test.js, PR #356 CI).
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || !stat.size) return { known: false };
    const size = Number(stat.size);
    const first = await firstRecord(file, size);
    if (first === null || !adapter.verify(JSON.parse(first), sessionId)) return { known: false };
    const window = await readWindow(file, size);
    if (window === null) return { known: false };
    const start = window.offset === 0 ? 0 : lastResetOffset(window, adapter, sessionId);
    if (start === null) return { known: false };
    const calls = new Map();
    const records = new Map();
    const tree = { parents: new Map(), ids: new Map(), leaf: null };
    let frames = [], offset = start, since = 0;
    let generation = start === 0 ? contentHash(first) : null;
    for (const line of window.bytes.subarray(start - window.offset).toString('utf8').split('\n').slice(0, -1)) {
      const end = offset + Buffer.byteLength(line) + 1;
      const record = JSON.parse(line);
      const link = adapter.link?.(record, sessionId);
      if (link) { tree.parents.set(link.id, link.parent); tree.ids.set(offset, link.id); tree.leaf = link.id; }
      if (recordOffsets.has(offset)) records.set(offset, record);
      for (const event of adapter.events(record, sessionId)) {
        if (event.type === 'reset') { calls.clear(); frames = []; generation = contentHash({ offset, line }); since = end; }
        if (event.type === 'call' && typeof event.id === 'string') calls.set(event.id, evidenceToolName(event));
        // A host-recorded Hook context is model-facing like a tool result; each
        // line is parsed on its own, so only a complete JSON frame counts.
        if (event.type === 'context') {
          for (const { value, visible, confirms = true } of preferenceFrames({ hookSpecificOutput: { additionalContext: event.output } })) {
            frames.push({ value, visible, confirms, offset, end, recordHash: contentHash(line) });
          }
          continue;
        }
        if (event.type !== 'result') continue;
        const name = calls.get(event.id);
        calls.delete(event.id);
        const codeMode = CODE_MODE.has(name);
        if (!codeMode && !DIRECT_TOOLS.test(name ?? '')) continue;
        for (const { value, visible, confirms = true } of preferenceFrames(event.output, codeMode)) {
          frames.push({ value, visible, confirms, offset, end, recordHash: contentHash(line) });
        }
      }
      offset = end;
    }
    const active = activeChain(tree);
    if (active) {
      frames = frames.filter(frame => active.has(tree.ids.get(frame.offset)));
      for (const at of records.keys()) if (!active.has(tree.ids.get(at))) records.delete(at);
    }
    return { known: true, fileId: `${stat.dev}:${stat.ino}`, size, generation, since, frames, records };
  } catch { return { known: false }; }
  finally { await file?.close(); }
}

// The first record, which names the session; null unless it is one whole line.
async function firstRecord(file, size) {
  const head = Buffer.alloc(Math.min(size, MAX_FIRST_RECORD_BYTES));
  const { bytesRead } = await file.read(head, 0, head.length, 0);
  const end = head.subarray(0, bytesRead).indexOf(10);
  return end < 0 ? null : head.subarray(0, end).toString('utf8');
}

// The whole file, or its last MAX_BYTES from the first record that starts in
// them; null unless the file ends with a complete record.
async function readWindow(file, size) {
  const from = size > MAX_BYTES ? size - MAX_BYTES - 1 : 0;
  const bytes = Buffer.alloc(size - from);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, from);
  if (bytesRead !== bytes.length || bytes.at(-1) !== 10) return null;
  if (from === 0) return { offset: 0, bytes };
  const skip = bytes.indexOf(10) + 1;
  return { offset: from + skip, bytes: bytes.subarray(skip) };
}

// Where the last reset record of a tail window starts, or null without one.
// Nothing before a reset is evidence, so nothing earlier has to be read.
function lastResetOffset(window, adapter, sessionId) {
  let offset = window.offset, found = null;
  for (const line of window.bytes.toString('utf8').split('\n').slice(0, -1)) {
    if (adapter.events(JSON.parse(line), sessionId).some(event => event.type === 'reset')) found = offset;
    offset += Buffer.byteLength(line) + 1;
  }
  return found;
}

// For a host whose records form a tree (an adapter with `link`), only the
// chain that ends at the latest linked record is the model's context: what a
// rewind left behind proves nothing. Null for a transcript without links,
// which is read in file order as before.
function activeChain({ parents, leaf }) {
  if (leaf === null) return null;
  const chain = new Set();
  for (let id = leaf; id !== null && parents.has(id) && !chain.has(id); id = parents.get(id)) chain.add(id);
  return chain;
}

function evidenceToolName(event) {
  if (!/^(?:mcp__fuli__|mcp__fuli\.)fuli_call$/.test(event.name ?? '')) return event.name;
  try {
    const input = typeof event.input === 'string' ? JSON.parse(event.input) : event.input;
    const direct = `mcp__fuli__${input?.toolName}`;
    return DIRECT_TOOLS.test(direct) ? direct : null;
  } catch { return null; }
}

export function preferenceFrameHash(value) {
  return contentHash(JSON.parse(canonicalJson(preferenceAuthorityView(value), { omitUndefined: true })));
}

function preferenceFrames(output, codeMode = false, depth = 0) {
  if (depth > 10 || output == null) return [];
  if (codeMode) {
    const blocks = Array.isArray(output) ? output : [{ text: output }];
    const text = blocks.map(block => block?.text ?? '').join('\n');
    if (!/^Script completed\b/.test(text) || /(?:Warning: truncated output|Script failed|Script running with cell ID)/.test(text)) return [];
    return blocks.slice(1).flatMap(block => preferenceFrames(block.text, false, depth + 1));
  }
  if (typeof output === 'string') {
    try { return preferenceFrames(JSON.parse(output), false, depth + 1); } catch { return []; }
  }
  if (Array.isArray(output)) return output.flatMap(block =>
    ['text', 'input_text', 'output_text'].includes(block?.type) ? preferenceFrames(block.text, false, depth + 1) : []);
  if (output.isError || output.is_error || output.error || output.preferences_complete === false
      || output.preference_delivery?.status === 'paginated') return [];
  const structured = output.structuredContent ?? output.structured_content;
  if (structured) {
    // The preference baseline is the structured copy whose preference view
    // the model also saw; anything else (recent context) must be proven from
    // what was actually visible, kept here as `visible`. Every other visible
    // copy confirms nothing, yet the model saw it, so it is kept with
    // `confirms: false`: the revision it shows is taken (rec#15 D-29.9).
    const expected = preferenceFrameHash(structured);
    return preferenceFrames(output.content, false, depth + 1).map(frame =>
      frame.confirms !== false && preferenceFrameHash(frame.value) === expected
        ? { value: structured, visible: frame.visible } : { ...frame, confirms: false });
  }
  if (typeof output.hookSpecificOutput?.additionalContext === 'string') {
    const lines = output.hookSpecificOutput.additionalContext.split('\n');
    return lines.flatMap(line => preferenceFrames(line, false, depth + 1));
  }
  if (typeof output.taskContextToken === 'string' && (Array.isArray(output.effective_preferences)
      || (output.preference_delivery?.status === 'delta' && Array.isArray(output.preference_updates)))) {
    return [{ value: output, visible: output }];
  }
  if (conversationResultRecovery(output)) return [{ value: output, visible: output }];
  return output.content ? preferenceFrames(output.content, false, depth + 1) : [];
}
