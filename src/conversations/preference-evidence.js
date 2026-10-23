import { constants } from 'node:fs';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { preferenceAuthorityView } from '../mcp/preference-delivery.js';
import { conversationResultRecovery } from './recent-context.js';

const MAX_BYTES = 32 * 1024 * 1024;
const DIRECT_TOOLS = /^(?:mcp__fuli__|mcp__fuli\.)(?:get_collaboration_preferences|begin_task_context|read_task_preferences|resume_agent_conversation|read_agent_conversation)$/;
const CODE_MODE = new Set(['functions.exec', 'functions.wait']);

// Inspect the native model-facing record, never Hook stdout, a log of writes,
// an assistant's claim, or a cache hit. Bounds/format uncertainty means full.
// since is where the current context generation starts (after the last reset
// record); records holds the complete native records that start at the
// requested byte offsets, as parsed.
export async function readPreferenceEvidence(path, sessionId, adapter, recordOffsets = new Set()) {
  let file;
  try {
    file = await openWithoutFollowing(path, constants.O_RDONLY);
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) return { known: false };
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || bytes.at(-1) !== 10) return { known: false };
    const calls = new Map();
    const records = new Map();
    let frames = [], offset = 0, generation = null, since = 0;
    for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
      const end = offset + Buffer.byteLength(line) + 1;
      const record = JSON.parse(line);
      if (offset === 0) {
        if (!adapter.verify(record, sessionId)) return { known: false };
        generation = contentHash(line);
      }
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
    return { known: true, fileId: `${stat.dev}:${stat.ino}`, size: bytes.length, generation, since, frames, records };
  } catch { return { known: false }; }
  finally { await file?.close(); }
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
