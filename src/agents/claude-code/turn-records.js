import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { normalizeClaudeRecord } from './conversation-transcript.js';

// The current turn of a Claude Code transcript as normalized records
// (turn-findings.js): everything after the last prompt the person typed. Only
// the transcript's tail is read; a turn longer than that is read from where
// the tail begins. Unreadable or unverified reads as no records.
const TAIL_BYTES = 1 << 20;

export function claudeTurnRecords(transcriptPath, sessionId) {
  if (typeof transcriptPath !== 'string' || typeof sessionId !== 'string') return [];
  let text;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const { size } = fstatSync(fd);
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const records = text.split('\n').filter(Boolean).flatMap(line => {
    try { return normalizeClaudeRecord(JSON.parse(line), sessionId); } catch { return []; }
  });
  const prompt = records.findLastIndex(record => record.role === 'user' && record.kind === 'message');
  return prompt < 0 ? records : records.slice(prompt + 1);
}
