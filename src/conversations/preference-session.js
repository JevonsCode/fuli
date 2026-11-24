import { constants } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { openWithoutFollowing } from '../system/open-without-following.js';
import { join } from 'node:path';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { acquireTranscriptGuardLock } from './transcript-guard-lock.js';
import { readPreferenceEvidence, preferenceFrameHash } from './preference-evidence.js';
import { applyPreferenceDeltaSnapshot, applySceneSwitchSnapshot, completePreferenceFrame, confirmableScene,
  frameOmittedIndex, framePreferenceSnapshot, heldPreferences, OWED_ID, pendingScene, preferenceIds, preferenceSnapshot,
  previousAgentPreferences, projectPreferenceDelta, shownRevision } from './preference-snapshot.js';
import { deliveredConversationFrame, deliveredRecentFrame, MAX_RECENT_FRAMES, ownRecordOffsets, projectRecentContext, recentEvidence,
  validRecentFrames, withoutDeliveryProofs } from './recent-context.js';
import { preferenceDeliveryReason } from '../mcp/preference-delivery.js';
import { locatePreferenceTranscript } from '../agents/preference-evidence.js';
import { ADDED_QUOTA_MAX, fitUncached, WHOLE_ENTRY } from './entry-inline-budget.js';
import { projectSkeleton, rememberSkeletonTask, skeletonEvidence, skeletonTasks } from './entry-skeleton.js';

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
// Version 3 adds `prompts`: [token, prompt, project and Agent] hashes of the
// tasks a hook delivered here (entry-skeleton.js, rec#76). A version 2 record
// has none, so its next hook frame carries the whole skeleton. Version 4
// replaces them with `tasks`: [token, project and Agent] hashes, since any task
// of the same owner may be a base (rec#88); a version 3 list is read as tasks.
// A pending item's optional `producedAt` (design T1) is read as absent by a
// version 4 FULI that predates it, which then never takes it as a base. So are
// its optional `authorityHash` (whose task it was, so a turn handed to another
// FLA is complete), `owed` (short hashes of the preferences added in its
// generation and scope, within the quota, that it did not spell out yet) and
// `spent` (how much of that quota the generation used; design T3,
// entry-inline-budget.js heldFit). A pending item without them owes none and
// has spent none: only a FULI that holds a set across frames ever leaves a
// new preference out of a frame it then builds on, and that one writes them;
// one without `authorityHash` names no hand-over, as before. Neither can
// exceed the quota's most (ADDED_QUOTA_MAX); a value past it, or malformed,
// makes the record untrusted, so the session starts a new generation with
// complete frames: never fewer bodies.
// Its optional top-level `known` ({ scope, ids }) is what the latest scope
// already had in view (heldPreferences): without it every preference a frame
// did not name is new, within the quota, which an older record reads as.
const RECORD_VERSION = 4;
const MAX_KNOWN = 1024;
export const PREFERENCE_SESSION_FORMAT = jsonFormat({ store: 'preference-session', versions: [1, 2, 3, RECORD_VERSION] });

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
  // `absent`: the host has not written this session's transcript yet (a new
  // session's first hooks), so nothing earlier exists and its boundary is its
  // start. Any other unreadable transcript stays unknown.
  async function observe(source, sessionId, origin, recordOffsets) {
    const target = await locate(source, sessionId, { env, transcriptPath: origin.transcriptPath });
    if (!target) return { known: false };
    const proof = await readPreferenceEvidence(target.path, sessionId, target.adapter, recordOffsets);
    return { ...proof, adapter: target.adapter, ...(proof.known ? {} : { absent: await missing(target.path) }) };
  }
  return {
    async recordConversation(value, origin, format) {
      const result = format(value);
      if (!SESSION.test(origin.nativeSessionId ?? '')) return result;
      try {
        await locked(origin.sourceApplication, origin.nativeSessionId, async (state, save) => {
          const proof = await observe(origin.sourceApplication, origin.nativeSessionId, origin);
          if (!proof.known) return;
          const nativeGeneration = origin.nativeGeneration ? contentHash(origin.nativeGeneration) : null;
          state = generationState(state, proof, nativeGeneration);
          const frame = deliveredConversationFrame(value, result);
          if (!frame) return;
          await save({ ...state, fileId: proof.fileId, generation: proof.generation,
            ...(nativeGeneration ? { nativeGeneration } : {}),
            recent: [...state.recent.filter(item => item.frameHash !== frame.frameHash), frame].slice(-MAX_RECENT_FRAMES) });
        });
      } catch { /* A cache failure never changes explicit history delivery. */ }
      return result;
    },
    // `fit` bounds the entry to a host's inline limit (entry-inline-budget.js);
    // the pending record is for the set the chosen frame actually delivers.
    // A hook entry passes its `taskPrompt` (null when it has none) and its
    // `label` (the instructions above a frame, by frame): only its frames
    // carry a skeleton revision or leave the skeleton out.
    async deliver(value, origin, format, fit = WHOLE_ENTRY) {
      const output = projected => format(withoutDeliveryProofs(projected));
      const snapshot = preferenceSnapshot(value);
      if (!snapshot || !SESSION.test(snapshot.sessionId) || origin.sourceApplication !== snapshot.sourceApplication) {
        return fitUncached(fit, value, output);
      }
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
          state = generationState(state, proof, nativeGeneration);
          // Without a readable generation no frame can ever be confirmed, so
          // none carries a revision. A transcript the host has not written yet
          // shows nothing so far, and a later turn reads this frame there.
          const { baseline, shown, previous = [] } = proof.known && state.floor !== null
            ? acknowledgedSnapshot(value, snapshot, state, proof)
            : proof.absent && state.floor !== null ? { baseline: null, shown: new Map() } : { baseline: null, shown: null };
          const provisional = shown && !origin.forceFull ? provisionalFrame(state, proof) : null;
          const floor = state.floor === null ? null : state.floor ?? 0;
          const evidence = origin.forceFull ? undefined
            : recentEvidence(proof, state.recent, { sessionId: snapshot.sessionId, adapter: proof.adapter, floor });
          // A forced full frame still carries its skeleton revision, so later
          // frames of the generation can name it. So does a frame produced
          // before the host wrote the transcript at all: a later turn confirms
          // it from there.
          const skeleton = origin.taskPrompt === undefined || !(proof.known || proof.absent) || floor === null ? null
            : skeletonEvidence(origin.forceFull ? { known: false } : proof, value,
              { floor, tasks: state.tasks, prompt: origin.taskPrompt });
          const project = candidate => {
            const preferences = origin.forceFull ? completePreferenceFrame(candidate, shown)
              : projectPreferenceDelta(candidate, baseline, shown, provisional, snapshot, previous);
            const recent = projectRecentContext(preferences, evidence);
            const value = projectSkeleton(recent.value, skeleton, origin.label);
            const result = output(value);
            // A frame the renderer blocks keeps the receipt and identity of
            // what it was given, so it is given the whole skeleton.
            if (value !== recent.value && result.structuredContent?.preferences_complete === false) {
              return { candidate, recent, result: output(recent.value) };
            }
            return { candidate, recent: { ...recent, value }, result };
          };
          // A complete frame names its skeleton as any frame would, so the fit
          // sizes the bytes it would really send.
          const complete = candidate => ({ candidate, result: output(projectSkeleton(completePreferenceFrame(candidate, shown,
            origin.forceFull ? [] : previous), skeleton && { bases: [] }, origin.label)) });
          // What the base frame listed, which a bounded entry never lists less
          // of while it fits (entry-inline-budget.js, design T3), so each later
          // frame can be a delta. In another scope (a project or work kind)
          // this frame is complete anyway and chooses afresh. While a frame is
          // still on its way (provisional) it adds none: one that adds would
          // name that frame as its base, and if it was lost the model could
          // not find it; one that adds none builds on what is recorded.
          // `known`: what this scope already had in view (heldPreferences).
          const known = state.known?.scope === snapshot.scopeHash ? state.known.ids : [];
          const held = baseline && !origin.forceFull && baseline.scopeHash === snapshot.scopeHash
            ? heldPreferences(baseline, { grow: !provisional, known }) : null;
          const chosen = fit(value, { deliver: project, complete, held });
          const { recent } = chosen;
          const projected = recent.value;
          // The set this frame delivers: a bounded frame's own subset, never
          // the preferences it leaves out (D-54).
          const delivered = preferenceSnapshot(chosen.candidate);
          result = chosen.result;
          const next = { ...state };
          // A pending hash means only produced. Only a matching complete native
          // record above can acknowledge it in a later call/process; a frame
          // without a revision can never be named as a base, so it keeps none.
          // producedAt is the transcript's length when it was produced: until
          // the model answers after that point, the frame is on its way into
          // the transcript (provisionalFrame).
          if (delivered && !result.isError && result.structuredContent?.preferences_complete !== false
              && shownRevision(result.structuredContent)
              && preferenceDeliveryReason(projected, result.structuredContent) === null
              && result.structuredContent?.preference_delivery?.status !== 'blocked') {
            // What it leaves owed and the quota spent, so a later frame built
            // on it still spells those out and adds no more past the quota
            // (entry-inline-budget.js heldFit). A frame chosen afresh keeps
            // the generation's spent quota, or none without a base.
            const owed = preferenceIds(value, chosen.added?.owed ?? []);
            const spent = chosen.added?.spent ?? held?.spent ?? 0;
            const pending = { scopeHash: delivered.scopeHash, snapshotHash: delivered.snapshotHash,
              frameHash: preferenceFrameHash(result.structuredContent), scene: pendingScene(delivered),
              authorityHash: delivered.authorityHash, ...(owed.length ? { owed } : {}), ...(spent ? { spent } : {}),
              ...(proof.known || proof.absent ? { producedAt: proof.known ? proof.size : 0 } : {}) };
            next.pending = [...(state.pending ?? []).filter(item => item.frameHash !== pending.frameHash), pending].slice(-MAX_PENDING);
            // A scope's first frame has its whole set in view; a later one adds
            // the new ones it left to rank. One kept once per scope, not per
            // frame, of at most MAX_KNOWN: a first frame past it keeps that
            // many, and a later one that would pass it adds none, so what the
            // scope had in view is never forgotten whole.
            const ids = held ? [...new Set([...known, ...preferenceIds(value, chosen.added?.declined ?? [])])].sort()
              : preferenceIds(value).slice(0, MAX_KNOWN);
            next.known = { scope: snapshot.scopeHash, ids: ids.length <= MAX_KNOWN ? ids : known };
          }
          const frame = deliveredRecentFrame(recent.frame, projected, result);
          if (frame) next.recent = [...state.recent.filter(item => item.frameHash !== frame.frameHash), frame].slice(-MAX_RECENT_FRAMES);
          if (skeleton && !result.isError) next.tasks = rememberSkeletonTask(state.tasks, value, origin.taskPrompt);
          if (state.floor !== null && (next.pending !== state.pending || next.recent !== state.recent || next.tasks !== state.tasks)) {
            await save({ ...next, ...(nativeGeneration ? { nativeGeneration } : {}),
              ...(proof.known ? { fileId: proof.fileId, generation: proof.generation } : {}) });
          }
          return result;
        });
      } catch { return result ?? fitUncached(fit, value, output); }
    },
    // Whether this context generation has given the session anything: a
    // frame FULI produced that the transcript records, or one still on its
    // way (provisionalFrame). A record or transcript that cannot be read has
    // given nothing (design T1: a host turn then gets the whole context).
    async delivered(origin) {
      if (!SESSION.test(origin.nativeSessionId ?? '')) return false;
      try {
        return await locked(origin.sourceApplication, origin.nativeSessionId, async state => {
          const proof = await observe(origin.sourceApplication, origin.nativeSessionId, origin);
          state = generationState(state, proof, origin.nativeGeneration ? contentHash(origin.nativeGeneration) : null);
          if (!proof.known || state.floor === null) return false;
          const recorded = recordedFrames(state, proof);
          return state.pending.some(item => recorded.has(item.frameHash)) || provisionalFrame(state, proof) !== null;
        });
      } catch { return false; }
    },
    // True once the next delivery for the session is a full one: the cache was
    // reset, or this session is never delta-delivered. False when it could not
    // be reset; a caller that promises a full context says so (rec#5 C3b).
    async reset(origin) {
      if (!SESSION.test(origin.nativeSessionId ?? '')) return true;
      try {
        await locked(origin.sourceApplication, origin.nativeSessionId, async (state, save) => {
          const proof = await observe(origin.sourceApplication, origin.nativeSessionId, origin);
          // An unreadable or unfinished transcript proves no boundary: it stays
          // unknown until a delivery can read the file, never the file's start.
          // A session the host says has just started has none yet: it starts
          // at its start.
          await save({ pending: [], recent: [], tasks: [], floor: boundary(proof, origin.sessionStarted === true),
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

// Where a new generation starts: the transcript's current end, or unknown
// (null). Only a session the host says has just started has no transcript
// yet because nothing was written: then the boundary is its start. Any other
// missing transcript may have been moved away and stays unknown (dot 6362902224).
function boundary(proof, started) {
  return proof.known ? proof.size : proof.absent && started ? 0 : null;
}

async function missing(path) {
  try { await lstat(path); return false; } catch (error) { return error?.code === 'ENOENT'; }
}

// A replaced or shortened file proves nothing that is in it now, so the next
// generation starts at its end. A reset record (compaction) of the same file
// starts a generation after that record, where the evidence reader begins.
function generationState(state, proof, nativeGeneration) {
  // A delivery that names its host execution and window starts a new
  // generation unless the record holds that same one: a hook reset or a
  // fresh record holds none, and a window change after it leaves no other
  // trace (review of #654).
  if (state.untrusted || state.floor === null || (nativeGeneration && nativeGeneration !== state.nativeGeneration)) {
    return { pending: [], recent: [], tasks: [], floor: boundary(proof, false) };
  }
  if (!proof.known) return state;
  const replaced = (state.fileId && state.fileId !== proof.fileId) || (state.floor ?? 0) > proof.size
    || (state.generation && state.generation !== proof.generation && !proof.since);
  if (replaced) return { pending: [], recent: [], tasks: [], floor: proof.size };
  if (state.generation && state.generation !== proof.generation) return { pending: [], recent: [], tasks: [], floor: 0 };
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
// Where the session's latest frame was another authority's (a turn handed to
// another FLA, #1063), there is none: the frame is complete, chooses afresh,
// and names what the frames since this authority's own spelled out that does
// not apply here (`previous`).
const AMBIGUOUS = Object.freeze({ snapshotHash: null });

function acknowledgedSnapshot(value, current, state, proof) {
  const pending = new Map((state.pending ?? []).map(item => [item.frameHash, item]));
  const shown = new Map();
  let baseline = null;
  let others = [];
  for (const frame of proof.frames) {
    const revision = shownRevision(frame.value);
    if (frame.offset < (state.floor ?? 0) || !revision) continue;
    // A frame that cannot confirm (a visible copy unlike its structured one)
    // still takes the revision the model saw.
    const expected = frame.confirms ? pending.get(preferenceFrameHash(frame.value)) : undefined;
    const delivered = expected ? verifiedFrame(value, frame.value, expected, revision, shown) : null;
    const known = shown.get(revision) ?? delivered;
    // The omission index the model holds with this frame (preference-snapshot.js
    // frameOmittedIndex): its own, or its base's where it said it was unchanged.
    const held = delivered ? { ...delivered, revision, omittedIndex: frameOmittedIndex(frame.value, shown),
      omittedConditional: frameOmittedIndex(frame.value, shown, 'conditional'),
      owed: expected.owed ?? [], spent: expected.spent ?? 0 } : null;
    shown.set(revision, delivered && known.snapshotHash === delivered.snapshotHash ? held : AMBIGUOUS);
    if (delivered?.authorityHash === current.authorityHash) baseline = held;
    if (expected?.authorityHash === current.authorityHash) others = [];
    else if (expected?.authorityHash) others.push(frame.value);
  }
  if (others.length) return { shown, baseline: null, previous: previousAgentPreferences(value, others) };
  return { shown, baseline: baseline && shown.get(baseline.revision).snapshotHash === baseline.snapshotHash ? baseline : null };
}

// The hashes of the frames FULI produced that this generation records.
function recordedFrames(state, proof) {
  return new Set(proof.frames.filter(frame => frame.offset >= (state.floor ?? 0))
    .map(frame => preferenceFrameHash(frame.value)));
}

// The session's latest produced frame while it is still on its way into the
// transcript: not recorded, and no model output since it was produced. Two
// host turns a few seconds apart run their hooks before the host writes the
// first frame, so the second would otherwise resend the same delta (design
// T1). Once the model answers after it and it is still missing, it was lost:
// it is no base, and the next frame builds on what the transcript records.
// Once written it is either recorded or on a branch a rewind left behind.
// A frame kept without producedAt (an older FULI) is never provisional.
function provisionalFrame(state, proof) {
  const latest = state.pending?.at(-1);
  if (!Number.isSafeInteger(latest?.producedAt) || !(proof.known || proof.absent)) return null;
  if (proof.known && (proof.written.has(latest.frameHash) || proof.outputAt >= latest.producedAt)) return null;
  return latest;
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
const FRESH = Object.freeze({ pending: Object.freeze([]), recent: Object.freeze([]), tasks: Object.freeze([]) });
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
          .every(hash => /^[a-f0-9]{64}$/.test(hash)) || !(item.scene === undefined || validScene(item.scene))
          || !(item.producedAt === undefined || (Number.isSafeInteger(item.producedAt) && item.producedAt >= 0))
          || !(item.authorityHash === undefined || /^[a-f0-9]{64}$/.test(item.authorityHash))
          || !(item.owed === undefined || (Array.isArray(item.owed) && item.owed.length <= ADDED_QUOTA_MAX
            && item.owed.every(id => typeof id === 'string' && OWED_ID.test(id))))
          || !(item.spent === undefined || (Number.isSafeInteger(item.spent) && item.spent >= 0
            && item.spent <= ADDED_QUOTA_MAX)))
        || !(value.known === undefined || (/^[a-f0-9]{64}$/.test(value.known?.scope) && Array.isArray(value.known.ids)
          && value.known.ids.length <= MAX_KNOWN && value.known.ids.every(id => typeof id === 'string' && OWED_ID.test(id))))) {
      return UNTRUSTED;
    }
    const recent = value.recent ?? [];
    const { prompts, ...kept } = value;
    const tasks = skeletonTasks(value.tasks ?? prompts ?? []);
    return validRecentFrames(recent) && tasks ? { ...kept, recent, tasks } : UNTRUSTED;
  } catch { return UNTRUSTED; }
  finally { await file.close(); }
}

const sceneValue = value => value === null || (typeof value === 'string' && value.length <= 64);
function validScene(scene) {
  return scene !== null && typeof scene === 'object' && sceneValue(scene.work_kind) && sceneValue(scene.workflow)
    && typeof scene.table === 'string' && scene.table.length <= 64;
}
