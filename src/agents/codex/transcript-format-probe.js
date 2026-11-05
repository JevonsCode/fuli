import { homedir } from 'node:os';
import { join } from 'node:path';

import { countTranscriptTail } from '../transcript-format-scan.js';
import { normalizeCodexRecord } from './conversation-transcript.js';

// Whether FULI still reads Codex's private rollout format: its newest
// rollout's tail, counted by the parser capture uses
// (conversation-transcript.js). Records the parser leaves out by design
// (developer messages, analysis) are not counted. Only messages are judged:
// Codex adds record and item types of its own, which say nothing about a turn.

function recognizeCodexRecord(record) {
  if (normalizeCodexRecord(record).length) return true;
  const item = record?.payload;
  if (record?.type !== 'response_item' || item?.type !== 'message') return null;
  if (typeof item.role !== 'string') return false;
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
