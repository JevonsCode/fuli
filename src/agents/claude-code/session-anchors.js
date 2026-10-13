import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { preferenceFileEndMarker } from '../../conversations/preference-file.js';

// Claude previews additionalContext above about 10,000 characters instead of
// showing it, so larger entries never count as delivered.
export const CLAUDE_INLINE_LIMIT = 9_500;
export const CLAUDE_ENTRY_LABEL = 'Fuli task context.';
const DELIVERY_TOKEN = /^(rules|preferences|identity):[0-9a-f]{12}$/;
const PREFERENCE_FILE = /^task-preferences-([0-9a-f]{12})\.md$/;
const TAIL_BYTES = 2 * 1024 * 1024;

// Proof that a full Fuli group is still in the conversation, after the latest
// compaction in the recent transcript and only from this session's own
// non-sidechain records: either a Fuli entry listed the token in
// session_delivery.delivered, or the model fully read the exact preference file
// a Fuli entry announced and the result reached the file's end marker.
// Anything unparsable, quoted elsewhere or older proves nothing, so the entry
// is delivered in full again.
export function claudeDeliveredTokens(transcriptPath, sessionId, { readTail = readTranscriptTail } = {}) {
  const delivered = new Set();
  const announced = new Map();
  const pendingReads = new Map();
  if (transcriptPath && sessionId) {
    try {
      for (const line of readTail(transcriptPath).split('\n')) {
        if (!line.includes('compact_boundary') && !line.includes('hook_additional_context')
          && !line.includes('task-preferences-') && !pendingReads.size) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.type === 'system' && record.subtype === 'compact_boundary') {
          delivered.clear();
          announced.clear();
          pendingReads.clear();
          continue;
        }
        if (record?.sessionId !== sessionId || record.isSidechain) continue;
        for (const entry of fuliEntries(record)) {
          for (const token of deliveredTokens(entry)) delivered.add(token);
          const file = announcedPreferenceFile(entry);
          if (file) announced.set(file.path, file.digest);
        }
        for (const [id, digest] of preferenceReads(record, announced)) pendingReads.set(id, digest);
        for (const [id, text] of successfulResults(record)) {
          const digest = pendingReads.get(id);
          if (digest && text.includes(preferenceFileEndMarker(digest))) delivered.add(`preferences:${digest}`);
          pendingReads.delete(id);
        }
      }
    } catch {
      delivered.clear();
    }
  }
  return (token) => delivered.has(token);
}

function fuliEntries(record) {
  const attachment = record?.attachment;
  if (record?.type !== 'attachment' || attachment?.type !== 'hook_additional_context'
    || attachment.hookEvent !== 'UserPromptSubmit' || !Array.isArray(attachment.content)) return [];
  return attachment.content.flatMap((text) => {
    if (typeof text !== 'string' || !text.startsWith(CLAUDE_ENTRY_LABEL)) return [];
    try {
      const entry = JSON.parse(text.slice(text.indexOf('\n{') + 1));
      return entry && typeof entry === 'object' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

function deliveredTokens(entry) {
  const tokens = entry.session_delivery?.delivered;
  return Array.isArray(tokens) ? tokens.filter((token) => typeof token === 'string' && DELIVERY_TOKEN.test(token)) : [];
}

function announcedPreferenceFile(entry) {
  const file = entry.effective_preferences_file?.file;
  if (typeof file !== 'string') return null;
  const match = PREFERENCE_FILE.exec(file.split(/[\\/]/).at(-1));
  return match ? { path: normalizePath(file), digest: match[1] } : null;
}

// Only a whole-file Read of a path a Fuli entry announced counts.
function preferenceReads(record, announced) {
  const content = record?.type === 'assistant' ? record.message?.content : null;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const input = block?.input;
    if (block?.type !== 'tool_use' || block.name !== 'Read' || typeof input?.file_path !== 'string'
      || Object.hasOwn(input, 'offset') || Object.hasOwn(input, 'limit')) return [];
    const digest = announced.get(normalizePath(input.file_path));
    return digest ? [[block.id, digest]] : [];
  });
}

function successfulResults(record) {
  const content = record?.type === 'user' ? record.message?.content : null;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool_result' && block.is_error !== true)
    .map((block) => [block.tool_use_id, resultText(block.content)]);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n') : '';
}

function normalizePath(path) {
  const forward = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

function readTranscriptTail(path) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    // The first line may be cut by the window; it cannot prove anything.
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    closeSync(descriptor);
  }
}
