import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';

const CHUNK_BYTES = 256 * 1024;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

// Per host session: the digests of the last full entry and how far the host
// transcript had grown. Only digests and a byte size are stored, never content.
export function readSessionDelivery({ directory, sourceApplication, sessionId, transcriptPath, compactionPattern }) {
  if (!transcriptPath || !sessionId) return { previous: null, reset: true };
  let state;
  try {
    state = JSON.parse(readFileSync(statePath(directory, sourceApplication, sessionId), 'utf8'));
  } catch {
    return { previous: null, reset: true };
  }
  if (state?.version !== 1 || !Number.isSafeInteger(state.transcriptBytes) || !state.digests) {
    return { previous: null, reset: true };
  }
  const size = transcriptSize(transcriptPath);
  // A shorter or missing transcript means the history was replaced.
  if (size === null || size < state.transcriptBytes) return { previous: state.digests, reset: true };
  return { previous: state.digests, reset: containsSince(transcriptPath, state.transcriptBytes, compactionPattern) };
}

export function writeSessionDelivery({ directory, sourceApplication, sessionId, transcriptPath }, digests,
  { now = Date.now() } = {}) {
  const size = transcriptPath ? transcriptSize(transcriptPath) : null;
  if (size === null || !sessionId) return;
  const sessions = join(directory, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const path = statePath(directory, sourceApplication, sessionId);
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, digests, transcriptBytes: size }), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  pruneSessions(sessions, path, now);
}

function pruneSessions(sessions, current, now) {
  let names;
  try { names = readdirSync(sessions); } catch { return; }
  for (const name of names) {
    const path = join(sessions, name);
    if (path === current || !/^[0-9a-f]{64}\.json$/.test(name)) continue;
    try {
      if (now - statSync(path).mtimeMs > RETAIN_MS) rmSync(path, { force: true });
    } catch { /* another hook may have removed it */ }
  }
}

function statePath(directory, sourceApplication, sessionId) {
  const key = createHash('sha256').update(`${sourceApplication}\0${sessionId}`).digest('hex');
  return join(directory, 'sessions', `${key}.json`);
}

function transcriptSize(path) {
  try { return statSync(path).size; } catch { return null; }
}

// Scans only what the host appended since the last full entry. A pattern match
// anywhere, even inside quoted tool output, errs toward a full delivery.
function containsSince(path, offset, pattern) {
  if (!pattern) return false;
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const overlap = 256;
    let position = offset;
    let carry = '';
    for (;;) {
      const read = readSync(descriptor, buffer, 0, CHUNK_BYTES, position);
      if (!read) return false;
      const text = carry + buffer.toString('utf8', 0, read);
      if (pattern.test(text)) return true;
      carry = text.slice(-overlap);
      position += read;
    }
  } catch {
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
