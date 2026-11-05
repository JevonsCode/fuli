import { homedir } from 'node:os';
import { join } from 'node:path';

import { countTranscriptTail } from '../transcript-format-scan.js';
import { normalizeClaudeRecord } from './conversation-transcript.js';

// Whether FULI still reads Claude Code's private JSONL format: its newest
// transcript's tail, counted by the parser capture uses
// (conversation-transcript.js). Records the parser leaves out by design
// (snapshots, system and progress records, thinking-only turns) are not counted.
const PARSED_TYPES = new Set(['user', 'assistant']);
const SKIPPED_TYPES = new Set(['summary', 'system', 'attachment', 'progress', 'file-history-snapshot',
  'queue-operation', 'custom-title', 'last-prompt']);
const SKIPPED_BLOCKS = new Set(['thinking', 'redacted_thinking', 'image', 'document']);
const leftOut = (block) => SKIPPED_BLOCKS.has(block?.type) || (block?.type === 'text' && block.text === '');

function recognizeClaudeRecord(record) {
  if (SKIPPED_TYPES.has(record?.type)) return null;
  if (!PARSED_TYPES.has(record?.type) || typeof record.sessionId !== 'string') return false;
  if (normalizeClaudeRecord(record, record.sessionId).length) return true;
  // An empty message, or one of only thinking, images or empty text, is left out by design.
  const content = record.message?.content;
  if (typeof content === 'string') return null;
  return Array.isArray(content) && content.every(leftOut) ? null : false;
}

// Claude Code keeps projects/<encoded-cwd>/<session>.jsonl under CLAUDE_CONFIG_DIR or ~/.claude.
export const claudeTranscriptFormat = Object.freeze({
  clientId: 'claude-code',
  root: (env) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
  depth: 1,
  probe: (path) => countTranscriptTail(path, recognizeClaudeRecord)
});
