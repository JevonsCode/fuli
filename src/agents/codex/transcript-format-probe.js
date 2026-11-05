import { homedir } from 'node:os';
import { join } from 'node:path';

import { countTranscriptTail } from '../transcript-format-scan.js';
import { normalizeCodexRecord } from './conversation-transcript.js';

// Whether FULI still reads Codex's private rollout format: its newest
// rollout's tail, counted by the parser capture uses
// (conversation-transcript.js). Records the parser leaves out by design
// (session and turn metadata, event mirrors, reasoning, developer messages,
// remote compaction) are not counted.
const SKIPPED_TYPES = new Set(['session_meta', 'turn_context', 'event_msg']);
const SKIPPED_ITEMS = new Set(['reasoning', 'web_search_call', 'local_shell_call', 'image_generation_call']);

function recognizeCodexRecord(record) {
  if (SKIPPED_TYPES.has(record?.type)) return null;
  if (normalizeCodexRecord(record).length) return true;
  if (record?.type === 'compacted') return typeof record.payload === 'object' ? null : false;
  if (record?.type !== 'response_item') return false;
  const item = record.payload;
  if (SKIPPED_ITEMS.has(item?.type)) return null;
  if (item?.type !== 'message' || typeof item.role !== 'string') return false;
  // Developer and analysis messages, and an empty turn, are left out by design.
  if (!['user', 'assistant'].includes(item.role) || item.channel === 'analysis') return null;
  return Array.isArray(item.content) && item.content.length === 0 ? null : false;
}

// Codex keeps sessions/YYYY/MM/DD/rollout-*.jsonl under CODEX_HOME or ~/.codex.
export const codexTranscriptFormat = Object.freeze({
  clientId: 'codex',
  root: (env) => join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'),
  depth: 3,
  probe: (path) => countTranscriptTail(path, recognizeCodexRecord)
});
