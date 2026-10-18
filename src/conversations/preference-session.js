import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from '../publication/canonical-json.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';
import { acquireTranscriptGuardLock } from './transcript-guard-lock.js';
import { readPreferenceEvidence, preferenceFrameHash } from './preference-evidence.js';
import { applyPreferenceDeltaSnapshot, copyPreferenceScope, preferenceSnapshot, projectPreferenceDelta } from './preference-snapshot.js';
import { preferenceDeliveryReason } from '../mcp/preference-delivery.js';
import { locatePreferenceTranscript } from '../agents/preference-evidence.js';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING = 16;

// This private cache contains only hashes/cursors. It never stores instruction
// bodies or grants authority. Native evidence is re-read on every use.
export function createSessionPreferenceDelivery({ directory, locate = locatePreferenceTranscript, env = process.env }) {
  const identify = (source, sessionId) => contentHash({ purpose: 'preference-delivery-v1', source, sessionId });
  async function locked(source, sessionId, operation) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Preference cache directory is unavailable');
    const key = identify(source, sessionId);
    const release = await acquireTranscriptGuardLock(directory, key);
    try {
      const path = join(directory, `${key}.json`);
      const state = await readState(path);
      return await operation(state, next => {
        writeJsonFileAtomic(path, { version: 1, ...next });
        return chmod(path, 0o600);
      });
    } finally { await release(); }
  }
  async function observe(source, sessionId, origin) {
    const target = await locate(source, sessionId, { env, transcriptPath: origin.transcriptPath });
    return target ? readPreferenceEvidence(target.path, sessionId, target.adapter) : { known: false };
  }
  return {
    async deliver(value, origin, format) {
      const snapshot = preferenceSnapshot(value);
      if (!snapshot || !SESSION.test(snapshot.sessionId) || origin.sourceApplication !== snapshot.sourceApplication) return format(value);
      const verified = origin.nativeSessionId === snapshot.sessionId;
      let result;
      try {
        return await locked(snapshot.sourceApplication, snapshot.sessionId, async (state, save) => {
          const proof = verified ? await observe(snapshot.sourceApplication, snapshot.sessionId, origin) : { known: false };
          const nativeGeneration = origin.nativeGeneration ? contentHash(origin.nativeGeneration) : null;
          if (nativeGeneration && state.nativeGeneration && nativeGeneration !== state.nativeGeneration) {
            state = { pending: [], floor: proof.known ? proof.size : 0 };
          }
          if (proof.known && ((state.fileId && state.fileId !== proof.fileId)
              || (state.generation && state.generation !== proof.generation) || (state.floor ?? 0) > proof.size)) {
            state = { pending: [], floor: 0 };
          }
          const baseline = proof.known ? acknowledgedSnapshot(value, snapshot, state, proof) : null;
          const projected = origin.forceFull ? value : projectPreferenceDelta(value, baseline);
          result = format(projected);
          // A pending hash means only produced. Only a matching complete native
          // tool result above can acknowledge it in a later call/process.
          if (!result.isError && result.structuredContent?.preferences_complete !== false
              && preferenceDeliveryReason(projected, result.structuredContent) === null
              && result.structuredContent?.preference_delivery?.status !== 'blocked') {
            const pending = { scopeHash: snapshot.scopeHash, snapshotHash: snapshot.snapshotHash,
              frameHash: preferenceFrameHash(result.structuredContent) };
            const existing = (state.pending ?? []).filter(item => item.frameHash !== pending.frameHash);
            await save({ ...state, ...(nativeGeneration ? { nativeGeneration } : {}),
              ...(proof.known ? { fileId: proof.fileId, generation: proof.generation } : {}),
              pending: [...existing, pending].slice(-MAX_PENDING) });
          }
          return result;
        });
      } catch { return result ?? format(value); }
    },
    async reset(origin) {
      if (!SESSION.test(origin.nativeSessionId ?? '')) return;
      try {
        await locked(origin.sourceApplication, origin.nativeSessionId, async (_state, save) => {
          const proof = await observe(origin.sourceApplication, origin.nativeSessionId, origin);
          await save({ pending: [], floor: proof.known ? proof.size : 0,
            ...(origin.nativeGeneration ? { nativeGeneration: contentHash(origin.nativeGeneration) } : {}),
            ...(proof.known ? { fileId: proof.fileId, generation: proof.generation } : {}) });
        });
      } catch { /* A missing cache can only cause a full delivery. */ }
    }
  };
}

function acknowledgedSnapshot(value, current, state, proof) {
  const pending = new Map((state.pending ?? []).filter(item => item.scopeHash === current.scopeHash)
    .map(item => [item.frameHash, item]));
  let baseline = null;
  for (const frame of proof.frames) {
    if (frame.offset < (state.floor ?? 0)) continue;
    const expected = pending.get(preferenceFrameHash(frame.value));
    if (!expected) continue;
    const delivered = frame.value.preference_delivery?.status === 'delta'
      ? applyPreferenceDeltaSnapshot(frame.value, baseline)
      : preferenceSnapshot(copyPreferenceScope(value, frame.value));
    if (delivered?.scopeHash !== current.scopeHash || delivered?.snapshotHash !== expected.snapshotHash) continue;
    baseline = { scopeHash: delivered.scopeHash, snapshotHash: delivered.snapshotHash,
      units: delivered.units, callId: frame.callId };
  }
  return baseline;
}

async function readState(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return { pending: [] };
    const value = JSON.parse(await file.readFile('utf8'));
    if (value.version !== 1 || !Array.isArray(value.pending) || value.pending.length > MAX_PENDING
        || value.pending.some(item => ![item.scopeHash, item.snapshotHash, item.frameHash]
          .every(hash => /^[a-f0-9]{64}$/.test(hash)))) return { pending: [] };
    return value;
  } catch { return { pending: [] }; }
  finally { await file?.close(); }
}
