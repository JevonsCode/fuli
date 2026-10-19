import { constants } from 'node:fs';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { canonicalJson, contentHash } from '../publication/canonical-json.js';
import { preferenceAuthorityView } from '../mcp/preference-delivery.js';

const MAX_BYTES = 32 * 1024 * 1024;
const DIRECT_TOOLS = /^(?:mcp__fuli__|mcp__fuli\.)(?:get_collaboration_preferences|begin_task_context|read_task_preferences)$/;
const CODE_MODE = new Set(['functions.exec', 'functions.wait']);

// Inspect the native model-facing record, never Hook stdout, a log of writes,
// an assistant's claim, or a cache hit. Bounds/format uncertainty means full.
export async function readPreferenceEvidence(path, sessionId, adapter) {
  let file;
  try {
    file = await openWithoutFollowing(path, constants.O_RDONLY);
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) return { known: false };
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || bytes.at(-1) !== 10) return { known: false };
    const calls = new Map();
    let frames = [], offset = 0, generation = null;
    for (const line of bytes.toString('utf8').split('\n').slice(0, -1)) {
      const end = offset + Buffer.byteLength(line) + 1;
      const record = JSON.parse(line);
      if (offset === 0) {
        if (!adapter.verify(record, sessionId)) return { known: false };
        generation = contentHash(line);
      }
      for (const event of adapter.events(record, sessionId)) {
        if (event.type === 'reset') { calls.clear(); frames = []; generation = contentHash({ offset, line }); }
        if (event.type === 'call' && typeof event.id === 'string') calls.set(event.id, event.name);
        // A host-recorded Hook context is model-facing like a tool result; each
        // line is parsed on its own, so only a complete JSON frame counts.
        if (event.type === 'context') {
          for (const value of preferenceFrames({ hookSpecificOutput: { additionalContext: event.output } })) {
            frames.push({ callId: event.id, value, offset, end, recordHash: contentHash(line) });
          }
          continue;
        }
        if (event.type !== 'result') continue;
        const name = calls.get(event.id);
        calls.delete(event.id);
        const codeMode = CODE_MODE.has(name);
        if (!codeMode && !DIRECT_TOOLS.test(name ?? '')) continue;
        for (const value of preferenceFrames(event.output, codeMode)) {
          frames.push({ callId: event.id, value, offset, end, recordHash: contentHash(line) });
        }
      }
      offset = end;
    }
    return { known: true, fileId: `${stat.dev}:${stat.ino}`, size: bytes.length, generation, frames };
  } catch { return { known: false }; }
  finally { await file?.close(); }
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
    const visible = preferenceFrames(output.content, false, depth + 1);
    return visible.some(value => preferenceFrameHash(value) === preferenceFrameHash(structured)) ? [structured] : [];
  }
  if (typeof output.hookSpecificOutput?.additionalContext === 'string') {
    const lines = output.hookSpecificOutput.additionalContext.split('\n');
    return lines.flatMap(line => preferenceFrames(line, false, depth + 1));
  }
  if (typeof output.taskContextToken === 'string' && (Array.isArray(output.effective_preferences)
      || (output.preference_delivery?.status === 'delta' && Array.isArray(output.preference_updates)))) return [output];
  return output.content ? preferenceFrames(output.content, false, depth + 1) : [];
}
