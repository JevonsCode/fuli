import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Claude previews additionalContext above about 10,000 characters instead of
// showing it, so larger entries never count as delivered.
export const CLAUDE_INLINE_LIMIT = 9_500;
export const CLAUDE_ENTRY_LABEL = 'Fuli task context.';
const DELIVERY_TOKEN = /^(rules|preferences|identity):[0-9a-f]{12}$/;
const PREFERENCE_FILE = /^task-preferences-([0-9a-f]{12})\.md$/;
const TAIL_BYTES = 2 * 1024 * 1024;

// Proof that a full Fuli group is still in the conversation: after the latest
// compaction in the recent transcript, Claude recorded this session's own
// UserPromptSubmit context whose Fuli entry lists the token in
// session_delivery.delivered, or the model successfully read a preference file
// that entry pointed to. Anything unparsable, quoted elsewhere or older proves
// nothing, so the entry is delivered in full again.
export function claudeDeliveredTokens(transcriptPath, sessionId, { readTail = readTranscriptTail } = {}) {
  const delivered = new Set();
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
          pendingReads.clear();
          continue;
        }
        if (record?.sessionId !== sessionId || record.isSidechain) continue;
        for (const token of entryTokens(record)) delivered.add(token);
        for (const [id, token] of preferenceReads(record)) pendingReads.set(id, token);
        for (const id of successfulResults(record)) {
          if (pendingReads.has(id)) delivered.add(pendingReads.get(id));
          pendingReads.delete(id);
        }
      }
    } catch {
      delivered.clear();
    }
  }
  return (token) => delivered.has(token);
}

function preferenceReads(record) {
  const content = record?.type === 'assistant' ? record.message?.content : null;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type !== 'tool_use' || block.name !== 'Read' || typeof block.input?.file_path !== 'string') return [];
    const match = PREFERENCE_FILE.exec(block.input.file_path.split(/[\\/]/).at(-1));
    return match && !block.input.offset && !block.input.limit ? [[block.id, `preferences:${match[1]}`]] : [];
  });
}

function successfulResults(record) {
  const content = record?.type === 'user' ? record.message?.content : null;
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool_result' && block.is_error !== true)
    .map((block) => block.tool_use_id);
}

function entryTokens(record) {
  const attachment = record?.attachment;
  if (record?.type !== 'attachment'
    || attachment?.type !== 'hook_additional_context' || attachment.hookEvent !== 'UserPromptSubmit'
    || !Array.isArray(attachment.content)) return [];
  return attachment.content.flatMap((text) => {
    if (typeof text !== 'string' || !text.startsWith(CLAUDE_ENTRY_LABEL)) return [];
    try {
      const entry = JSON.parse(text.slice(text.indexOf('\n{') + 1));
      const tokens = entry?.session_delivery?.delivered;
      return Array.isArray(tokens) ? tokens.filter((token) => typeof token === 'string' && DELIVERY_TOKEN.test(token)) : [];
    } catch {
      return [];
    }
  });
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
