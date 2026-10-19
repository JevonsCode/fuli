import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { captureDisabled } from '../graphiti/capture-decision.js';
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

export function notRecordedEvent(from, to, reason) {
  return { event_id: `jsonl-v1:${from}:${to}:not_recorded`, role: 'tool', kind: 'tool_result',
    content: `[Not recorded: automatic recording was off (${reason}); native bytes ${from} to ${to} were skipped and remain in native history.]` };
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

// The settings version this host session was last synchronized under. A
// session without one is unattributable unless no settings were ever saved.
export function transcriptCaptureLedger(runtimeConfigPath, input, sourceApplication) {
  const path = join(dirname(runtimeConfigPath), 'transcript-capture',
    `${transcriptDigest(`${runtimeConfigPath}\0${sourceApplication}\0${input.session_id}`)}.json`);
  return {
    async unattributable(version) {
      if (version === null) return true;
      let stored = null;
      try { stored = JSON.parse(await readFile(path, 'utf8')).settings ?? null; }
      catch { /* missing or unreadable: compare against no record */ }
      return stored === null ? version !== 'absent' : stored !== version;
    },
    record(version) {
      if (version === null) return;
      try { writeJsonFileAtomic(path, { version: 1, settings: version }); }
      catch { /* the next sync stays unattributable, which only skips more */ }
    }
  };
}
