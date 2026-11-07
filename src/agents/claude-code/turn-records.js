import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { normalizeClaudeRecord } from './conversation-transcript.js';

// The current turn of a Claude Code transcript as normalized records
// (turn-findings.js): the turn's prompt and everything after it. The prompt is
// the last user message that is not only a <system-reminder> the host adds
// mid-turn; a turn the host itself started (a <side-sessions-event>) keeps that
// note as its prompt, so the reader can tell nobody typed it. Only the
// transcript's tail is read; a turn longer than that is read from where the
// tail begins. Unreadable or unverified reads as no records.
const TAIL_BYTES = 1 << 20;
const REMINDERS_ONLY = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*$/u;

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
  const lines = text.split('\n').filter(Boolean).map(line => {
    try { return normalizeClaudeRecord(JSON.parse(line), sessionId); } catch { return []; }
  });
  const prompt = lines.findLastIndex(records => records.some(record => record.role === 'user' && record.kind === 'message'
    && !REMINDERS_ONLY.test(record.content)));
  return lines.slice(Math.max(prompt, 0)).flat();
}
