import { constants } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';

import { openWithoutFollowing } from '../system/open-without-following.js';

// The file reading behind each Agent's transcript format probe
// (src/agents/<agent>/transcript-format-probe.js): find a client's newest
// transcript, and count how many records of its tail the Agent's own parser
// reads. Only counts leave this module: no text, path or session ID.
const TAIL_BYTES = 256 * 1024;
const MAX_SCAN_ENTRIES = 10_000;
// This many lines with no turn at all: the turns themselves were renamed.
const NO_TURNS_LINES = 20;

// The newest .jsonl file under root, at most depth directories down, changed
// at or after since (ms); null when there is none. Symbolic links are not followed.
export async function newestTranscript(root, { depth, since }) {
  const scan = { entries: 0, newest: null };
  await visit(root, depth, since, scan);
  return scan.newest?.path ?? null;
}

async function visit(directory, depth, since, scan) {
  let entries;
  try { entries = await opendir(directory); } catch { return; }
  for await (const entry of entries) {
    if (++scan.entries > MAX_SCAN_ENTRIES) break;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) await visit(path, depth - 1, since, scan);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const changedAt = await lstat(path).then((stat) => stat.mtimeMs, () => -Infinity);
      if (changedAt >= since && changedAt > (scan.newest?.changedAt ?? -Infinity)) scan.newest = { path, changedAt };
    }
  }
}

// recognize(record) answers true when the parser reads the record, false when
// it should and cannot, and null for a record the parser leaves out by design.
// A line that is not JSON counts as one the parser cannot read. The first line
// of a cut tail and a record the client is still writing are not counted.
export async function countTranscriptTail(path, recognize) {
  const file = await openWithoutFollowing(path, constants.O_RDONLY);
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const tail = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(tail, 0, tail.length, start);
    const lines = tail.subarray(0, bytesRead).toString('utf8').split('\n');
    lines.pop();
    if (start > 0) lines.shift();
    let recognized = 0;
    let total = 0;
    const records = lines.filter((candidate) => candidate.trim());
    for (const line of records) {
      const verdict = recognizeLine(line, recognize);
      if (verdict === null) continue;
      total += 1;
      if (verdict) recognized += 1;
    }
    return { readable: true, recognized, total: total || (records.length >= NO_TURNS_LINES ? records.length : 0) };
  } finally {
    await file.close();
  }
}

function recognizeLine(line, recognize) {
  // A parser that throws on a record cannot read it: that is the finding.
  try { return recognize(JSON.parse(line)); } catch { return false; }
}
