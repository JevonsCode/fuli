import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { advanceCaptureSettingsVersion, captureDisabled, captureSettingsVersion } from '../graphiti/capture-decision.js';
import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { jsonFormat, updateVersionedJsonFileAtomic, withJsonFormatDirectory, writeVersionedJsonFileAtomic }
  from '../storage/json-format.js';
import { lookupTranscriptTask } from './current-task-lookup.js';
import { importTranscriptSpan } from './transcript-append.js';
import { transcriptDigest } from './transcript-guard.js';
import { verifiedTranscriptEnd } from './transcript-reader.js';

// Native transcript turns automatic recording did not cover. While a capture
// decision denies, a sync still moves the session cursor past what the host
// wrote and stores only a content-free marker (byte range and reason; the
// Provider dates the event), so a per-session view can show the gap. After
// capture comes back, turns written while the capture settings changed cannot
// be attributed to one decision, so they are marked the same way instead of
// imported. Project modes and session pause reuse this through the decision
// (they deny) and the settings version (they change it).
export const UNATTRIBUTABLE = 'capture_changed';
// A denial could not be kept in the session's record and the settings
// generation moved instead; or nothing local could be written at all.
const STATE_UNSAVED = 'capture_state_unsaved';
const STATE_UNWRITABLE = 'capture_state_unwritable';
// A turn whose task ownership was never confirmed (rec#15): neither the task
// that was current nor any other, so it is not imported under either.
export const TURN_UNRESOLVED = 'turn_ownership_unresolved';

// Sessions whose denial this process could not keep, with the settings
// version it was made under. While that version holds, every sync of the
// session skips. A newer version already makes the old record stale, and a
// denial or sync record that is saved again ends it.
const unkeptDenials = new Map();

// A denial says recording was off; a settings change only says FULI could
// not confirm the stretch was allowed. Neither names any skipped content.
const SKIPPED_BECAUSE = Object.freeze({
  [UNATTRIBUTABLE]: 'capture settings changed, so this stretch could not be confirmed as allowed and was skipped',
  [STATE_UNSAVED]: 'the capture state could not be saved safely, so this stretch was skipped',
  [TURN_UNRESOLVED]: 'this turn\'s task ownership was not confirmed, so it was not recorded under any task'
});
const RECORDING_OFF = /^automatic recording was off \((\w+)\)$/;
const MARKER = /^\[Not recorded: (.+); native bytes \d+ to \d+ remain in native history\.\]$/;

export function notRecordedEvent(from, to, reason) {
  const why = SKIPPED_BECAUSE[reason] ?? `automatic recording was off (${reason})`;
  return { event_id: `jsonl-v1:${from}:${to}:not_recorded`, role: 'tool', kind: 'tool_result',
    content: `[Not recorded: ${why}; native bytes ${from} to ${to} remain in native history.]` };
}

// The reason a marker above was written for, read back by a session's record
// list (rec#5 C6); null for anything that is not such a marker.
export function notRecordedReason(content) {
  const why = MARKER.exec(String(content ?? ''))?.[1];
  if (!why) return null;
  return Object.keys(SKIPPED_BECAUSE).find(reason => SKIPPED_BECAUSE[reason] === why) ?? RECORDING_OFF.exec(why)?.[1] ?? null;
}

// Best effort: when the marker cannot be written the cursor stays, and the
// settings change that brings capture back makes the interval unattributable.
// unsynced (the ledger's unsyncedSpan()) covers the bytes an expired capture
// saw before capture was denied: the marker saying recording was off starts
// after them.
export async function skipTranscriptWhileOff(application, input, sourceApplication, adapter, decision, unsynced = null) {
  const disabled = captureDisabled(decision);
  if (!input?.transcript_path) return disabled;
  const result = await skipTranscriptSpan(application, input, sourceApplication, decision.reason,
    () => verifiedTranscriptEnd(input.transcript_path, input.session_id, adapter), { adapter, unsynced });
  return result.status === 'skipped' ? { ...disabled, skipped: { from: result.from, to: result.to } } : disabled;
}

// Moves the session cursor up to native byte end() with only the marker
// above: 'skipped', 'none' when nothing before it is still unimported or the
// session imports nothing (no task Agent, no verified start), or 'failed'.
// Bytes before unsynced.until come first, as the capture that saw them
// decided (rec#16): imported under the task that was current then, if it
// still is, otherwise skipped with that capture's reason. Nothing is marked
// past them until they are covered.
export async function skipTranscriptSpan(application, input, sourceApplication, reason, end, { adapter, unsynced = null } = {}) {
  try {
    const { task, failure } = await lookupTranscriptTask(application, input, sourceApplication);
    if (failure) return { status: 'failed' };
    if (!task?.project_agent_id) return { status: 'none' };
    const scope = { personal_space_id: application.config.personal.spaceId, personal_project_id: task.personal_project_id,
      agent_id: task.project_agent_id, source_application: sourceApplication, session_id: input.session_id };
    const session = await application.personal.conversation('query', { ...scope, mode: 'session' });
    let from = session.cursor ?? 0;
    if (!session.initialized) return { status: 'none' };
    const write = { ...scope, task_context_token: task.token };
    const mark = async (start, stop, why) => (await application.personal.conversation('append', { ...write,
      events: [notRecordedEvent(start, stop, why)], expected_cursor: start, cursor: stop })).status === 'saved';
    if (unsynced && unsynced.until > from) {
      const proven = unsynced.owner !== undefined && unsynced.owner === transcriptDigest(task.token);
      const covered = proven ? await importTranscriptSpan(application, { ...write, expected_cursor: from }, input, adapter, unsynced.until)
        : await mark(from, unsynced.until, unsynced.reason ?? TURN_UNRESOLVED) ? unsynced.until : from;
      if (covered < unsynced.until) return { status: 'failed' };
      from = unsynced.until;
    }
    const to = await end();
    if (to <= from) return { status: 'none' };
    return await mark(from, to, reason) ? { status: 'skipped', from, to } : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

// A non-entry hook whose capture window expired (rec#16) keeps, for a later
// hook while capture is denied, what it had decided for the native bytes it
// saw (up to their verified end): an import under the task it found current
// (owner, a token digest), or why they are skipped. An import is kept only if
// the settings generation it decided under still holds once their end is
// read, no handoff is pending and the task is known; otherwise they are
// skipped as unattributable or unresolved, never marked as written while
// recording was off. Best effort: without it the later marker covers them.
export async function keepUnsynced(application, ledger, input, adapter, { settings, notRecorded, owner, handoffPending }) {
  if (!ledger || !input?.transcript_path) return;
  let until;
  try { until = await verifiedTranscriptEnd(input.transcript_path, input.session_id, adapter); } catch { return; }
  const reason = captureSettingsVersion(application, input.session_id) !== settings ? UNATTRIBUTABLE
    : notRecorded ?? (handoffPending || !owner ? TURN_UNRESOLVED : null);
  ledger.observeUnsynced(reason ? { until, reason } : { until, owner });
}

// What this host session's transcript was last handled under, kept locally:
// the settings generation of its last sync, a denial no recorded sync has
// skipped yet, and the turns whose task ownership is unresolved (rec#15).
// A session without a record is unattributable unless no settings were ever
// saved. The generation is global for now (any client's switch moves it); see
// the capture settings store's version() for the planned per-layer generations.
//
// Version 2 adds the unresolved turns. They decide whether a sync may import
// and whether a Stop may settle the session's task, so they are not droppable
// metadata: a FULI that guards this store refuses to rewrite a version 2
// record, and this version reads a newer or unreadable record as held. Version
// 1 records hold no turns and are read as they are; every write is version 2.
//   held: [{ turn, from, owner }] each unresolved turn in order, with its id,
//     the native byte it began after and its task's token digest (null until known)
//   unprovable: true when held turns were lost (an unreadable record was
//     replaced, or too many turns); held until a fresh task entry
//   skipUntil: native byte before which nothing may be imported; set by a
//     fresh task entry for what was left of the turns it ended
//   unsynced: { until, owner } or { until, reason } (rec#16) what a capture
//     that expired decided for the native bytes before `until` (keepUnsynced),
//     read only by a skip while capture is denied. Unlike the turns, it may be
//     dropped: a FULI that drops it, or reads it as invalid, only marks those
//     bytes as written while recording was off, as before; it never imports.
//     So it stays in version 2.
export const TRANSCRIPT_CAPTURE_FORMAT = jsonFormat({ store: 'transcript-capture-ledger', versions: [1, 2] });
const LEDGER_VERSION = 2;
// When the session's record cannot be written, an unresolved turn is kept
// here instead, in its own directory and lock: the session is then held until
// a fresh task entry.
export const TRANSCRIPT_TURN_HOLD_FORMAT = jsonFormat({ store: 'transcript-turn-hold', versions: [1] });
const MAX_HELD_TURNS = 64;
// A path that cannot exist: the file, or a directory on its way, is not there.
const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const NOT_HELD = Object.freeze({ unprovable: false, turns: Object.freeze([]), skipUntil: null });

export function transcriptCaptureLedger(runtimeConfigPath, input, sourceApplication) {
  const key = transcriptDigest(`${runtimeConfigPath}\0${sourceApplication}\0${input.session_id}`);
  const path = join(dirname(runtimeConfigPath), 'transcript-capture', `${key}.json`);
  const holdPath = join(dirname(runtimeConfigPath), 'transcript-turn-holds', `${key}.json`);
  const update = (mutate) => updateVersionedJsonFileAtomic(path, TRANSCRIPT_CAPTURE_FORMAT,
    (current) => { const next = mutate(current); return next && ledgerDocument(next); }, { read: readLedger });
  const held = () => {
    const current = readLedger(path);
    if (current.state === 'unprovable' || current.record.unprovable || fallbackHeld(holdPath)) {
      return { ...NOT_HELD, unprovable: true };
    }
    return { unprovable: false, turns: current.record.held, skipUntil: current.record.skipUntil };
  };
  // Removes a file under its directory's lock only if `keep(current)` is
  // false for what is there now: never a state another process wrote since.
  const removeUnless = (filePath, format, keep) => {
    if (!exists(filePath)) return true;
    return withJsonFormatDirectory(filePath, ({ remove }) => {
      if (keep()) return false;
      remove(filePath, format);
      return true;
    }, { format });
  };
  return {
    // Why the next stretch must be skipped instead of imported, or null. A
    // pending denial comes first: the Provider may have been unable to take
    // its marker while the settings never changed (dot's #228 review). Any
    // unresolved turn, or a state that cannot be proven, skips.
    async skipReason(version) {
      if (version === null) return UNATTRIBUTABLE;
      if (unkeptDenials.get(path) === version) return STATE_UNSAVED;
      const current = readLedger(path);
      if (current.state === 'unprovable') return TURN_UNRESOLVED;
      const record = current.record;
      if (typeof record.pending === 'string') return record.pending;
      if (record.unprovable || record.held.length || record.skipUntil !== null || fallbackHeld(holdPath)) return TURN_UNRESOLVED;
      return (record.settings === null ? version !== 'absent' : record.settings !== version) ? UNATTRIBUTABLE : null;
    },
    // Kept before anything else when a decision denies: 'kept'. If it cannot
    // be kept the record is removed, since a denial means settings were saved
    // and a session with no record is skipped, never imported: 'removed'. If
    // the old record cannot be removed either it stays readable, so it must
    // not be trusted again in this process: 'unkept' (see keepDenial()). A
    // record that holds turns is never removed.
    // The first pending reason is read and kept under the format lock with
    // the write (rec#17), so a denial saved meanwhile is never lost.
    async deny(version, reason) {
      try {
        update((current) => ({ ...current.record, settings: version,
          pending: typeof current.record.pending === 'string' ? current.record.pending : reason }));
        unkeptDenials.delete(path);
        return 'kept';
      } catch (error) {
        // A record a newer FULI wrote, or one another process holds the lock
        // on, is neither replaced nor removed: the stretch is not imported.
        if (error instanceof DataFormatError || error?.code === 'file_lock_busy') {
          unkeptDenials.set(path, version);
          return 'unkept';
        }
      }
      try {
        // Read, checked and removed under one hold of the lock: a turn another
        // process holds meanwhile is never removed with the record.
        const removed = removeUnless(path, TRANSCRIPT_CAPTURE_FORMAT, () => {
          const current = readLedger(path);
          return current.state === 'unprovable' || holdsTurns(current.record) || fallbackHeld(holdPath);
        });
        if (!removed) throw new Error('A record that holds turns is kept');
        unkeptDenials.delete(path);
        return 'removed';
      } catch {
        unkeptDenials.set(path, version);
        return 'unkept';
      }
    },
    // After a sync that covered the stretch, by importing it or by a marker
    // the Provider saved. This clears a pending denial, never an unresolved
    // turn: only its own resolution ends that.
    record(version) {
      if (version === null) return;
      try {
        update((current) => ({ ...current.record, settings: version, pending: null, unsynced: null }));
        unkeptDenials.delete(path);
      } catch { /* the next sync stays unattributable, which only skips more */ }
    },
    // The session's unresolved turns: unprovable (held, but which turns is not
    // known), or the turns in order and the byte nothing before may be imported.
    heldTurns: held,
    // What a task entry starting now observes, so that it later ends only
    // these turns: their ids and the exact bytes of both stores (a digest; null
    // when absent, undefined when unreadable).
    entrySnapshot() {
      const current = readLedger(path);
      const fallback = fileDigest(holdPath);
      return { turns: current.record.held.map(turn => turn.turn), ledger: current.digest, fallback,
        any: current.state === 'unprovable' || holdsTurns(current.record) || fallback !== null };
    },
    // Holds the turn that begins now (`turn`, a fresh id) from native byte
    // `from`, after any older held turn. While turns are held every sync skips
    // with TURN_UNRESOLVED and the Stop hook does not settle the session's
    // task; a session reset, compaction or FULI going off leaves them held.
    // 'ledger' or 'fallback' says where it was kept; false when nowhere.
    holdTurn({ turn, from }) {
      try {
        update((current) => {
          const turns = [...current.record.held, { turn, from, owner: null }];
          return turns.length > MAX_HELD_TURNS ? { ...current.record, held: [], unprovable: true }
            : { ...current.record, held: turns };
        });
        return 'ledger';
      } catch {
        try {
          writeVersionedJsonFileAtomic(holdPath, { version: 1, turn, from }, TRANSCRIPT_TURN_HOLD_FORMAT);
          return 'fallback';
        } catch { return false; }
      }
    },
    // The task that was current when the held turn began, once it is known.
    ownTurn(turnId, owner) {
      try {
        update((current) => current.record.held.some(turn => turn.turn === turnId) ? { ...current.record,
          held: current.record.held.map(turn => turn.turn === turnId ? { ...turn, owner } : turn) } : undefined);
      } catch { /* an unknown owner keeps the turn held */ }
    },
    // Ends every held turn once their spans are skipped, or the last of them
    // was proven: only while `latest` is still the last turn held. True when
    // nothing remains held for those turns.
    endTurns(latest) {
      let ended = false;
      try {
        update((current) => {
          if (current.record.held.at(-1)?.turn !== latest) return undefined;
          ended = true;
          return { ...current.record, held: [], skipUntil: null };
        });
        return ended;
      } catch { return false; }
    },
    // A fresh task entry ends what it observed when it started (`snapshot`),
    // and nothing before byte `before` may be imported. A store unchanged
    // since then is cleared, an unprovable state included; a changed one loses
    // only the observed turns, so a turn held while the entry ran stays held.
    // False when it could not be saved, which keeps them held.
    enteredAfter(before, snapshot) {
      if (!snapshot.any) return true;
      const observed = new Set(snapshot.turns);
      try {
        update((current) => {
          const skipUntil = Math.max(before, current.record.skipUntil ?? 0);
          if (snapshot.ledger !== undefined && current.digest === snapshot.ledger) {
            return { ...current.record, held: [], unprovable: false, skipUntil };
          }
          if (current.state !== 'record') return undefined;
          return { ...current.record, held: current.record.held.filter(turn => !observed.has(turn.turn)), skipUntil };
        });
        if (snapshot.fallback === null) return true;
        return snapshot.fallback !== undefined && removeUnless(holdPath, TRANSCRIPT_TURN_HOLD_FORMAT,
          () => fileDigest(holdPath) !== snapshot.fallback);
      } catch { return false; }
    },
    // The span before `skipUntil` was skipped.
    skipped(skipUntil) {
      try {
        update((current) => current.record.skipUntil === skipUntil ? { ...current.record, skipUntil: null } : undefined);
      } catch { /* skipping it again only skips nothing more */ }
    },
    // What a capture that expired decided for the bytes it saw (keepUnsynced);
    // a newer one replaces it and a covering sync (record) drops it. Never
    // written over a record that cannot be proven.
    observeUnsynced(span) {
      try {
        update((current) => current.state === 'unprovable' ? undefined : { ...current.record, unsynced: span });
      } catch { /* the later marker then covers these bytes, as before */ }
    },
    // That decision for a skip while capture is denied, or null. A turn held
    // or a skip boundary set since means its owner may no longer be the
    // task that is current, so it is skipped as unresolved instead of imported.
    unsyncedSpan() {
      const current = readLedger(path);
      const span = current.state === 'record' && !current.record.unprovable ? current.record.unsynced : null;
      if (!span?.owner) return span;
      const moved = current.record.skipUntil !== null || current.record.held.some(turn => turn.from < span.until)
        || fallbackHeld(holdPath);
      return moved ? { until: span.until, reason: TURN_UNRESOLVED } : span;
    }
  };
}

// Keeps a denial for the session's later syncs. Returns null when that is
// safe, or the transcript state a hook must report. A denial the session's
// record could not keep moves the settings generation, a second channel in
// another file, so the old record is stale for every process. If that cannot
// be saved either, only this process knows: a new process could trust the
// old record, so the hook says so and the person has to check by hand.
export async function keepDenial(application, ledger, version, reason) {
  if (!ledger || await ledger.deny(version, reason) !== 'unkept') return null;
  return advanceCaptureSettingsVersion(application) ? STATE_UNSAVED : STATE_UNWRITABLE;
}

function emptyLedger() {
  return { settings: null, pending: null, held: [], unprovable: false, skipUntil: null, unsynced: null };
}

function unprovableLedger() {
  return { state: 'unprovable', record: { ...emptyLedger(), unprovable: true } };
}

// The record as 'absent', 'record' or 'unprovable': unreadable, not JSON, a
// version this FULI does not know, or a held state it cannot read. A writer
// that replaces an unprovable record keeps it unprovable (held).
function readLedger(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    return MISSING.has(error?.code) ? { state: 'absent', digest: null, record: emptyLedger() }
      : { ...unprovableLedger(), digest: undefined };
  }
  return { ...parseLedger(text), digest: transcriptDigest(text) };
}

function parseLedger(text) {
  let value;
  try { value = JSON.parse(text); } catch { return unprovableLedger(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unprovableLedger();
  const pending = typeof value.pending === 'string' ? value.pending : null;
  if (value.version === 1) return { state: 'record', record: { ...emptyLedger(), settings: value.settings ?? null, pending } };
  if (value.version !== LEDGER_VERSION) return unprovableLedger();
  const held = value.held ?? [];
  if (!Array.isArray(held) || !held.every(heldTurn)
      || (value.skipUntil !== undefined && !(Number.isSafeInteger(value.skipUntil) && value.skipUntil >= 0))
      || (value.unprovable !== undefined && value.unprovable !== true)) return unprovableLedger();
  return { state: 'record', record: { settings: value.settings ?? null, pending, held,
    unprovable: value.unprovable === true, skipUntil: value.skipUntil ?? null, unsynced: unsyncedSpan(value.unsynced) } };
}

// Either an import's owner (a token digest) or a skip reason (a reason code,
// never content). Anything else is dropped, which never imports.
function unsyncedSpan(span) {
  if (!span || !Number.isSafeInteger(span.until) || span.until < 0) return null;
  if (/^[a-f0-9]{64}$/.test(span.owner ?? '') && span.reason === undefined) return { until: span.until, owner: span.owner };
  if (/^[a-z_]{1,64}$/.test(span.reason ?? '') && span.owner === undefined) return { until: span.until, reason: span.reason };
  return null;
}

function heldTurn(turn) {
  return Boolean(turn && typeof turn.turn === 'string' && turn.turn && Number.isSafeInteger(turn.from) && turn.from >= 0
    && (turn.owner === null || typeof turn.owner === 'string'));
}

function ledgerDocument(record) {
  return { version: LEDGER_VERSION, ...(record.settings === null || record.settings === undefined ? {} : { settings: record.settings }),
    ...(typeof record.pending === 'string' ? { pending: record.pending } : {}),
    ...(record.held?.length ? { held: record.held } : {}), ...(record.unprovable ? { unprovable: true } : {}),
    ...(record.skipUntil === null || record.skipUntil === undefined ? {} : { skipUntil: record.skipUntil }),
    ...(record.unsynced ? { unsynced: record.unsynced } : {}) };
}

function holdsTurns(record) {
  return Boolean(record.held.length || record.unprovable || record.skipUntil !== null);
}

// The file's exact bytes as a digest: null when absent, undefined when it cannot be read.
function fileDigest(path) {
  try { return transcriptDigest(readFileSync(path)); } catch (error) { return MISSING.has(error?.code) ? null : undefined; }
}

function exists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (MISSING.has(error?.code)) return false;
    throw error;
  }
}

// A fallback hold that exists in any form, or that cannot be read, holds the session.
function fallbackHeld(path) {
  try { readFileSync(path); return true; } catch (error) { return !MISSING.has(error?.code); }
}
