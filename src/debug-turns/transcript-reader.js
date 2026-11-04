import { constants } from 'node:fs';

import { sha256Bytes } from '../security/digest.js';
import { openWithoutFollowing } from '../system/open-without-following.js';

// How much of a transcript a #debug Stop reads: its tail. A record keeps at
// most 2 MB, so a longer read would only be cut again.
const TAIL_BYTES = 16 * 1024 * 1024;
const HEADER_BYTES = 512 * 1024;

export const debugPromptDigest = (prompt) => sha256Bytes(prompt);

// The host's own transcript of this session through its Agent's adapter
// (src/agents/<id>/conversation-transcript.js: verify and normalize), split
// at this turn's prompt: the events since the last compaction before it are
// the history, the events after it are the turn. Read only; never written.
export async function readDebugTranscript(path, sessionId, adapter, promptDigest) {
  if (!adapter || typeof path !== 'string' || !path) return { status: adapter ? 'unavailable' : 'not_supported' };
  let file;
  try {
    file = await openWithoutFollowing(path, constants.O_RDONLY);
  } catch {
    return { status: 'unavailable' };
  }
  try {
    const { size } = await file.stat();
    const header = Buffer.alloc(Math.min(HEADER_BYTES, size));
    await file.read(header, 0, header.length, 0);
    const firstEnd = header.indexOf(10);
    if (firstEnd < 0 || !adapter.verify(parsedLine(header.subarray(0, firstEnd).toString('utf8')), sessionId)) {
      return { status: 'unavailable' };
    }
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = Buffer.alloc(size - start);
    await file.read(tail, 0, tail.length, start);
    const lines = tail.toString('utf8').split('\n');
    // A tail that starts inside a record drops that partial line.
    if (start > 0) lines.shift();
    const events = lines.flatMap((line) => {
      const record = line.trim() ? parsedLine(line) : null;
      return record ? adapter.normalize(record, sessionId) : [];
    });
    return { status: 'read', ...splitAtPrompt(events, promptDigest, start === 0) };
  } finally {
    await file.close();
  }
}

function parsedLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function splitAtPrompt(events, promptDigest, fromStart) {
  const isPrompt = (event) => event.role === 'user' && event.kind === 'message' && debugPromptDigest(event.content) === promptDigest;
  const at = events.findLastIndex(isPrompt);
  const turnStart = at < 0 ? events.length : at;
  const compaction = events.slice(0, turnStart).findLastIndex((event) => event.kind === 'compaction_summary');
  return {
    history: events.slice(Math.max(0, compaction), turnStart),
    // Complete when it starts at a compaction or at the session's first record.
    historyComplete: compaction >= 0 || fromStart,
    events: at < 0 ? [] : events.slice(at + 1)
  };
}
