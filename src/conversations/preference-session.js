import { constants } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { join } from 'node:path';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { acquireTranscriptGuardLock } from './transcript-guard-lock.js';
import { readPreferenceEvidence, preferenceFrameHash } from './preference-evidence.js';
import { applyPreferenceDeltaSnapshot, applySceneSwitchSnapshot, completePreferenceFrame, confirmableScene,
  framePreferenceSnapshot, pendingScene, preferenceSnapshot, projectPreferenceDelta, shownRevision } from './preference-snapshot.js';
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
// A pending item's `scene` (rec#15 D-29.2) is the scene its frame was produced
// for; an item written without one never confirms, so its frame is resent in
// full. An older FULI ignores it and still binds the frame to its own scope hash.
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
          // A record this FULI cannot trust (newer, corrupt, oversized) may have
          // held a reset's boundary; a reset that could not read the transcript
          // saved its boundary as unknown (floor null); a new native window has
          // one too. In each case the generation starts at the current end, or
          // stays unknown: nothing before it counts and nothing is saved.
          if (state.untrusted || state.floor === null
              || (nativeGeneration && state.nativeGeneration && nativeGeneration !== state.nativeGeneration)) {
            state = { pending: [], recent: [], floor: proof.known ? proof.size : null };
          }
          if (proof.known && state.floor !== null) state = generationState(state, proof);
          // Without a readable generation no frame can ever be confirmed, so
          // none carries a revision.
          const { baseline, shown } = proof.known && state.floor !== null ? acknowledgedSnapshot(value, snapshot, state, proof)
            : { baseline: null, shown: null };
          const preferences = origin.forceFull ? completePreferenceFrame(value, shown) : projectPreferenceDelta(value, baseline, shown);
          const recent = projectRecentContext(preferences, origin.forceFull ? undefined
            : recentEvidence(proof, state.recent, { sessionId: snapshot.sessionId, adapter: proof.adapter,
              floor: state.floor === null ? null : state.floor ?? 0 }));
          const projected = recent.value;
          result = output(projected);
          const next = { ...state };
          // A pending hash means only produced. Only a matching complete native
          // record above can acknowledge it in a later call/process; a frame
          // without a revision can never be named as a base, so it keeps none.
          if (!result.isError && result.structuredContent?.preferences_complete !== false
              && shownRevision(result.structuredContent)
              && preferenceDeliveryReason(projected, result.structuredContent) === null
              && result.structuredContent?.preference_delivery?.status !== 'blocked') {
            const pending = { scopeHash: snapshot.scopeHash, snapshotHash: snapshot.snapshotHash,
              frameHash: preferenceFrameHash(result.structuredContent), scene: pendingScene(snapshot) };
            next.pending = [...(state.pending ?? []).filter(item => item.frameHash !== pending.frameHash), pending].slice(-MAX_PENDING);
          }
          const frame = deliveredRecentFrame(recent.frame, projected, result);
          if (frame) next.recent = [...state.recent.filter(item => item.frameHash !== frame.frameHash), frame].slice(-MAX_RECENT_FRAMES);
          if (state.floor !== null && (next.pending !== state.pending || next.recent !== state.recent)) {
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
          // An unreadable or unfinished transcript proves no boundary: it stays
          // unknown until a delivery can read the file, never the file's start.
          await save({ pending: [], recent: [], floor: proof.known ? proof.size : null,
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

// What this generation shows the model, by preference revision (rec#15
// D-29.3, D-29.9). Every complete, model-visible frame the host recorded at or
// after the floor counts, whatever its record ID: a Claude attachment, a Codex
// command-hook context (its adapter proves the hook provenance) or a tool
// result. A revision names one verified set, or none once two frames show it
// for different sets or one of them cannot be verified. The baseline is the
// latest verified frame of the current authority, in any scene, whose revision
// names it alone; a delta or scene switch then names it by that revision.
const AMBIGUOUS = Object.freeze({ snapshotHash: null });

function acknowledgedSnapshot(value, current, state, proof) {
  const pending = new Map((state.pending ?? []).map(item => [item.frameHash, item]));
  const shown = new Map();
  let baseline = null;
  for (const frame of proof.frames) {
    const revision = shownRevision(frame.value);
    if (frame.offset < (state.floor ?? 0) || !revision) continue;
    const delivered = verifiedFrame(value, frame.value, pending.get(preferenceFrameHash(frame.value)), revision, shown);
    const known = shown.get(revision) ?? delivered;
    shown.set(revision, delivered && known.snapshotHash === delivered.snapshotHash ? { ...delivered, revision } : AMBIGUOUS);
    if (delivered?.authorityHash === current.authorityHash) baseline = { ...delivered, revision };
  }
  return { shown, baseline: baseline && shown.get(baseline.revision).snapshotHash === baseline.snapshotHash ? baseline : null };
}

// A recorded frame as the set its producer kept the pending hash for, built
// on the base its own revision field names, in the scene the pending item kept.
function verifiedFrame(value, frame, expected, revision, shown) {
  if (!expected || !confirmableScene(expected.scene)) return null;
  const delivery = frame.preference_delivery;
  const delivered = delivery?.status === 'delta' ? applyPreferenceDeltaSnapshot(frame, shown.get(delivery.base_revision))
    : delivery?.status === 'scene_switch' ? applySceneSwitchSnapshot(value, frame, shown.get(delivery.supersedes), expected.scene)
      : framePreferenceSnapshot(value, frame, expected.scene);
  return delivered?.scopeHash === expected.scopeHash && delivered.snapshotHash === expected.snapshotHash
    && delivered.snapshotHash.startsWith(revision) ? delivered : null;
}

// A session with no record yet starts fresh at the file's beginning. Any other
// record this FULI cannot read as its own is untrusted, not fresh: it may hold
// the boundary of a reset that is not visible in the native file.
const FRESH = Object.freeze({ pending: Object.freeze([]), recent: Object.freeze([]) });
const UNTRUSTED = Object.freeze({ ...FRESH, untrusted: true });

async function readState(path) {
  let file;
  try {
    file = await openWithoutFollowing(path, constants.O_RDONLY);
  } catch (error) {
    return error?.code === 'ENOENT' ? FRESH : UNTRUSTED;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return UNTRUSTED;
    const value = JSON.parse(await file.readFile('utf8'));
    if (!PREFERENCE_SESSION_FORMAT.versions.includes(value.version) || !Array.isArray(value.pending)
        || value.pending.length > MAX_PENDING
        || !(value.floor === undefined || value.floor === null || Number.isSafeInteger(value.floor))
        || value.pending.some(item => ![item.scopeHash, item.snapshotHash, item.frameHash]
          .every(hash => /^[a-f0-9]{64}$/.test(hash)) || !(item.scene === undefined || validScene(item.scene)))) return UNTRUSTED;
    const recent = value.recent ?? [];
    return validRecentFrames(recent) ? { ...value, recent } : UNTRUSTED;
  } catch { return UNTRUSTED; }
  finally { await file.close(); }
}

const sceneValue = value => value === null || (typeof value === 'string' && value.length <= 64);
function validScene(scene) {
  return scene !== null && typeof scene === 'object' && sceneValue(scene.work_kind) && sceneValue(scene.workflow)
    && typeof scene.table === 'string' && scene.table.length <= 64;
}
