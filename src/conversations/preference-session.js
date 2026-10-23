import { constants } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { join } from 'node:path';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { acquireTranscriptGuardLock } from './transcript-guard-lock.js';
import { readPreferenceEvidence, preferenceFrameHash } from './preference-evidence.js';
import { applyPreferenceDeltaSnapshot, copyPreferenceScope, preferenceSnapshot, projectPreferenceDelta } from './preference-snapshot.js';
import { deliveredRecentFrame, MAX_RECENT_FRAMES, ownRecordOffsets, projectRecentContext, recentEvidence,
  validRecentFrames, withoutDeliveryProofs } from './recent-context.js';
import { preferenceDeliveryReason } from '../mcp/preference-delivery.js';
import { locatePreferenceTranscript } from '../agents/preference-evidence.js';

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PENDING = 16;
// Version 2 adds `recent`: the recent-context frames this session was sent
// (conversation, frame hash, sequence + content hash pairs; recent-context.js).
// A version 1 record has none and is read as such, then written as version 2.
// An older FULI refuses a version 2 record and delivers in full, as it does
// for any cache it cannot read; nothing is ever confirmed from a missing entry.
const RECORD_VERSION = 2;
export const PREFERENCE_SESSION_FORMAT = jsonFormat({ store: 'preference-session', versions: [1, RECORD_VERSION] });

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
        writeVersionedJsonFileAtomic(path, { ...next, version: RECORD_VERSION }, PREFERENCE_SESSION_FORMAT);
        return chmod(path, 0o600);
      });
    } finally { await release(); }
  }
  async function observe(source, sessionId, origin, recordOffsets) {
    const target = await locate(source, sessionId, { env, transcriptPath: origin.transcriptPath });
    return target ? { ...await readPreferenceEvidence(target.path, sessionId, target.adapter, recordOffsets),
      adapter: target.adapter } : { known: false };
  }
  return {
    async deliver(value, origin, format) {
      const output = projected => format(withoutDeliveryProofs(projected));
      const snapshot = preferenceSnapshot(value);
      if (!snapshot || !SESSION.test(snapshot.sessionId) || origin.sourceApplication !== snapshot.sourceApplication) return output(value);
      const verified = origin.nativeSessionId === snapshot.sessionId;
      let result;
      try {
        return await locked(snapshot.sourceApplication, snapshot.sessionId, async (state, save) => {
          const proof = verified ? await observe(snapshot.sourceApplication, snapshot.sessionId, origin, ownRecordOffsets(value))
            : { known: false };
          const nativeGeneration = origin.nativeGeneration ? contentHash(origin.nativeGeneration) : null;
          if (nativeGeneration && state.nativeGeneration && nativeGeneration !== state.nativeGeneration) {
            state = { pending: [], recent: [], floor: proof.known ? proof.size : 0 };
          }
          if (proof.known) state = generationState(state, proof);
          const baseline = proof.known ? acknowledgedSnapshot(value, snapshot, state, proof) : null;
          const preferences = origin.forceFull ? value : projectPreferenceDelta(value, baseline);
          const recent = projectRecentContext(preferences, origin.forceFull ? undefined
            : recentEvidence(proof, state.recent, { sessionId: snapshot.sessionId, adapter: proof.adapter, floor: state.floor ?? 0 }));
          const projected = recent.value;
          result = output(projected);
          const next = { ...state };
          // A pending hash means only produced. Only a matching complete native
          // tool result above can acknowledge it in a later call/process.
          if (!result.isError && result.structuredContent?.preferences_complete !== false
              && preferenceDeliveryReason(projected, result.structuredContent) === null
              && result.structuredContent?.preference_delivery?.status !== 'blocked') {
            const pending = { scopeHash: snapshot.scopeHash, snapshotHash: snapshot.snapshotHash,
              frameHash: preferenceFrameHash(result.structuredContent) };
            next.pending = [...(state.pending ?? []).filter(item => item.frameHash !== pending.frameHash), pending].slice(-MAX_PENDING);
          }
          const frame = deliveredRecentFrame(recent.frame, projected, result);
          if (frame) next.recent = [...state.recent.filter(item => item.frameHash !== frame.frameHash), frame].slice(-MAX_RECENT_FRAMES);
          if (next.pending !== state.pending || next.recent !== state.recent) {
            await save({ ...next, ...(nativeGeneration ? { nativeGeneration } : {}),
              ...(proof.known ? { fileId: proof.fileId, generation: proof.generation } : {}) });
          }
          return result;
        });
      } catch { return result ?? output(value); }
    },
    // True once the next delivery for the session is a full one: the cache was
    // reset, or this session is never delta-delivered. False when it could not
    // be reset; a caller that promises a full context says so (rec#5 C3b).
    async reset(origin) {
      if (!SESSION.test(origin.nativeSessionId ?? '')) return true;
      try {
        await locked(origin.sourceApplication, origin.nativeSessionId, async (_state, save) => {
          const proof = await observe(origin.sourceApplication, origin.nativeSessionId, origin);
          await save({ pending: [], recent: [], floor: proof.known ? proof.size : 0,
            ...(origin.nativeGeneration ? { nativeGeneration: contentHash(origin.nativeGeneration) } : {}),
            ...(proof.known ? { fileId: proof.fileId, generation: proof.generation } : {}) });
        });
        return true;
      } catch {
        return false;
      }
    }
  };
}

// A replaced or shortened file proves nothing that is in it now, so the next
// generation starts at its end. A reset record (compaction) of the same file
// starts a generation after that record, where the evidence reader begins.
function generationState(state, proof) {
  const replaced = (state.fileId && state.fileId !== proof.fileId) || (state.floor ?? 0) > proof.size
    || (state.generation && state.generation !== proof.generation && !proof.since);
  if (replaced) return { pending: [], recent: [], floor: proof.size };
  if (state.generation && state.generation !== proof.generation) return { pending: [], recent: [], floor: 0 };
  return state;
}

function acknowledgedSnapshot(value, current, state, proof) {
  const pending = new Map((state.pending ?? []).filter(item => item.scopeHash === current.scopeHash)
    .map(item => [item.frameHash, item]));
  let baseline = null;
  for (const frame of proof.frames) {
    // A delta names its base result; a record without an ID cannot be one.
    if (frame.offset < (state.floor ?? 0) || !frame.callId) continue;
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

const EMPTY = Object.freeze({ pending: Object.freeze([]), recent: Object.freeze([]) });

async function readState(path) {
  let file;
  try {
    file = await openWithoutFollowing(path, constants.O_RDONLY);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return EMPTY;
    const value = JSON.parse(await file.readFile('utf8'));
    if (!PREFERENCE_SESSION_FORMAT.versions.includes(value.version) || !Array.isArray(value.pending)
        || value.pending.length > MAX_PENDING
        || value.pending.some(item => ![item.scopeHash, item.snapshotHash, item.frameHash]
          .every(hash => /^[a-f0-9]{64}$/.test(hash)))) return EMPTY;
    const recent = value.recent ?? [];
    return validRecentFrames(recent) ? { ...value, recent } : EMPTY;
  } catch { return EMPTY; }
  finally { await file?.close(); }
}
