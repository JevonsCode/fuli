import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { advanceCaptureSettingsVersion, captureDisabled } from '../graphiti/capture-decision.js';
import { writeJsonFileAtomic } from '../storage/json-file.js';
import { lookupTranscriptTask } from './current-task-lookup.js';
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

// Sessions whose denial this process could not keep, with the settings
// version it was made under. While that version holds, every sync of the
// session skips. A newer version already makes the old record stale, and a
// denial or sync record that is saved again ends it.
const unkeptDenials = new Map();

// A denial says recording was off; a settings change only says FULI could
// not confirm the stretch was allowed. Neither names any skipped content.
const SKIPPED_BECAUSE = Object.freeze({
  [UNATTRIBUTABLE]: 'capture settings changed, so this stretch could not be confirmed as allowed and was skipped',
  [STATE_UNSAVED]: 'the capture state could not be saved safely, so this stretch was skipped'
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
export async function skipTranscriptWhileOff(application, input, sourceApplication, adapter, decision) {
  const disabled = captureDisabled(decision);
  if (!input?.transcript_path) return disabled;
  try {
    const { task, failure } = await lookupTranscriptTask(application, input, sourceApplication);
    if (failure || !task?.project_agent_id) return disabled;
    const scope = { personal_space_id: application.config.personal.spaceId, personal_project_id: task.personal_project_id,
      agent_id: task.project_agent_id, source_application: sourceApplication, session_id: input.session_id };
    const session = await application.personal.conversation('query', { ...scope, mode: 'session' });
    const from = session.cursor ?? 0;
    if (!session.initialized) return disabled;
    const to = await verifiedTranscriptEnd(input.transcript_path, input.session_id, adapter);
    if (to <= from) return disabled;
    const saved = await application.personal.conversation('append', { ...scope, task_context_token: task.token,
      events: [notRecordedEvent(from, to, decision.reason)], expected_cursor: from, cursor: to });
    return saved.status === 'saved' ? { ...disabled, skipped: { from, to } } : disabled;
  } catch {
    return disabled;
  }
}

// What this host session's transcript was last handled under, kept locally:
// the settings generation of its last sync, and a denial no recorded sync has
// skipped yet. A session without a record is unattributable unless no settings
// were ever saved. The generation is global for now (any client's switch moves
// it); see the capture settings store's version() for the planned per-layer
// generations.
export function transcriptCaptureLedger(runtimeConfigPath, input, sourceApplication) {
  const path = join(dirname(runtimeConfigPath), 'transcript-capture',
    `${transcriptDigest(`${runtimeConfigPath}\0${sourceApplication}\0${input.session_id}`)}.json`);
  const stored = async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch { return null; }
  };
  return {
    // Why the next stretch must be skipped instead of imported, or null. A
    // pending denial comes first: the Provider may have been unable to take
    // its marker while the settings never changed (dot's #228 review).
    async skipReason(version) {
      if (version === null) return UNATTRIBUTABLE;
      if (unkeptDenials.get(path) === version) return STATE_UNSAVED;
      const record = await stored();
      if (typeof record?.pending === 'string') return record.pending;
      const settings = record?.settings ?? null;
      return (settings === null ? version !== 'absent' : settings !== version) ? UNATTRIBUTABLE : null;
    },
    // Kept before anything else when a decision denies: 'kept'. If it cannot
    // be kept the record is removed, since a denial means settings were saved
    // and a session with no record is skipped, never imported: 'removed'. If
    // the old record cannot be removed either it stays readable, so it must
    // not be trusted again in this process: 'unkept' (see keepDenial()).
    async deny(version, reason) {
      const pending = (await stored())?.pending;
      try {
        writeJsonFileAtomic(path, { version: 1, settings: version,
          pending: typeof pending === 'string' ? pending : reason });
        unkeptDenials.delete(path);
        return 'kept';
      } catch { /* try removing the old record */ }
      try {
        await rm(path, { force: true });
        unkeptDenials.delete(path);
        return 'removed';
      } catch {
        unkeptDenials.set(path, version);
        return 'unkept';
      }
    },
    // After a sync that covered the stretch, by importing it or by a marker
    // the Provider saved. This clears a pending denial.
    record(version) {
      if (version === null) return;
      try {
        writeJsonFileAtomic(path, { version: 1, settings: version });
        unkeptDenials.delete(path);
      } catch { /* the next sync stays unattributable, which only skips more */ }
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
