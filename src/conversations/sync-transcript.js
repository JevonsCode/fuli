import { initialTranscriptBoundary, readTranscriptBatch } from './transcript-reader.js';
import { transcriptDigest, TRANSCRIPT_SCAN_PAGE_LIMIT } from './transcript-guard.js';
import { lookupTranscriptTask } from './current-task-lookup.js';
import { appendTranscriptPage } from './transcript-append.js';
import { recoverFallbackTranscript } from './fallback-transcript-boundary.js';
import { captureDecision, captureDisabled } from '../graphiti/capture-decision.js';
import { notRecordedEvent, skipTranscriptWhileOff } from './transcript-capture-gap.js';

const pending = reason => ({ status: 'partial', entryBlocked: true, reason });
const retryReason = 'Transcript handoff is pending. Retry task entry to continue its saved progress; no new Agent context was supplied';

// What a host hook knows about the session whose transcript it would capture.
// Every host works in some directory: a hook that does not report it cannot
// show that its session is outside a project FULI must not record.
export function transcriptCaptureScope(input, sourceApplication) {
  const projectPath = typeof input?.cwd === 'string' && input.cwd.trim() ? input.cwd : null;
  return { sourceApplication, projectPath, sessionId: input?.session_id ?? null,
    ...(projectPath ? {} : { projectUnknown: true }) };
}

// The transcript is saved under the session's current task, which may belong
// to a project other than the directory: both have to be recorded.
function taskTranscriptScope(input, sourceApplication, task) {
  return { ...transcriptCaptureScope(input, sourceApplication), personalProjectId: task.personal_project_id ?? null };
}

// Nothing of a task that is not recorded is ever imported, so no handoff for
// it stays pending: a later recorded task starts from its own prompt. Its
// turns are skipped like any other off period (transcript-capture-gap.js).
async function skippedTaskTranscript(application, input, sourceApplication, adapter, decision, guard) {
  if (guard?.value) await guard.clear();
  return skipTranscriptWhileOff(application, input, sourceApplication, adapter, decision);
}

// notRecorded names why the pending interval must be skipped instead of
// imported (transcript-capture-gap.js); the cursor still advances as usual.
export async function syncConversationTranscript(application, input, sourceApplication, adapter, guard = null,
  { notRecorded = null } = {}) {
  const capture = await captureDecision(application, transcriptCaptureScope(input, sourceApplication));
  if (!capture.allowed) return skipTranscriptWhileOff(application, input, sourceApplication, adapter, capture);
  if (!input?.transcript_path) return { status: 'partial', reason: 'Host did not supply a visible transcript' };
  if (guard?.expired) return pending('Transcript guard lifetime expired; this unverified interval was not imported');
  if (guard?.value?.phase === 'scan' && (guard.value.scanPages ?? 0) >= TRANSCRIPT_SCAN_PAGE_LIMIT) {
    return pending('Transcript scan budget limit reached; this unverified interval was not imported');
  }
  let committedPages = 0, ownershipKnown = false, skipped = false;
  try {
    const lookup = await lookupTranscriptTask(application, input, sourceApplication);
    if (lookup.failure) return lookup.failure;
    const task = lookup.task;
    ownershipKnown = true;
    if (!task?.project_agent_id) return guard?.value ? pending(retryReason) : { status: 'unassigned' };
    const taskCapture = await captureDecision(application, taskTranscriptScope(input, sourceApplication, task));
    if (!taskCapture.allowed) return skippedTaskTranscript(application, input, sourceApplication, adapter, taskCapture, guard);
    const scope = { personal_space_id: application.config.personal.spaceId, personal_project_id: task.personal_project_id,
      agent_id: task.project_agent_id, source_application: sourceApplication };
    const policy = await application.personal.conversation('query', { ...scope, mode: 'policy' });
    if (!policy.enabled) return { status: 'capture_disabled' };
    let session = await application.personal.conversation('query', { ...scope, mode: 'session', session_id: input.session_id });
    const recovered = await recoverFallbackTranscript(application, input, sourceApplication, adapter, guard, task, session);
    if (recovered) return recovered;
    if (!session.initialized) return guard?.value ? pending('Transcript initialization changed during handoff. Start a new host session and resume the intended Agent') : { status: 'partial', reason: 'Transcript capture needs a verified task entry boundary' };
    if (guard?.value?.phase === 'claim') {
      if (guard.value.nextOwner !== transcriptDigest(task.token)) return pending('Transcript task ownership changed during handoff. Start a new host session and resume the intended Agent');
      await application.personal.conversation('boundary', { ...scope, session_id: input.session_id,
        task_context_token: task.token, expected_cursor: guard.value.boundary, cursor: guard.value.boundary });
      await guard.clear();
    } else if (guard?.value && guard.value.owner !== transcriptDigest(task.token)) {
      return pending('Transcript task ownership changed during handoff. Start a new host session and resume the intended Agent');
    }
    if (typeof input.prompt === 'string' && guard && !guard.value) {
      await guard.write({ version: 1, phase: 'scan', owner: transcriptDigest(task.token),
        prompt: transcriptDigest(input.prompt), scanCursor: session.cursor ?? 0, userMessages: 0, omitted: false });
    }
    if (guard?.value && typeof input.prompt === 'string' && guard.value.prompt !== transcriptDigest(input.prompt)) {
      return pending('An earlier transcript handoff is pending. Retry the earlier task entry before sending a different prompt');
    }
    if (guard?.value?.phase === 'beginning') return pending('Task entry was interrupted before its new ownership was recorded. Start a new host session and resume the intended Agent; this uncertain native tail was not imported');
    if (guard?.value?.phase === 'scan') {
      for (let page = 0; page < 8; page++) {
        const state = guard.value;
        if ((state.scanPages ?? 0) >= TRANSCRIPT_SCAN_PAGE_LIMIT) {
          return pending('Transcript scan budget limit reached; this unverified interval was not imported');
        }
        const batch = await readTranscriptBatch(input.transcript_path, input.session_id, state.scanCursor, adapter,
          { stopBeforeDigest: state.prompt });
        const next = { ...state, scanCursor: batch.cursor, scanPages: (state.scanPages ?? 0) + 1,
          userMessages: state.userMessages + (batch.userMessages ?? 0), omitted: state.omitted || batch.omitted === true,
          uncertainFrom: state.uncertainFrom ?? batch.uncertainFrom ?? null };
        if (batch.atPromptBoundary) {
          await guard.write({ ...next, scanCursor: batch.promptEndCursor,
            candidate: batch.cursor, userMessages: next.userMessages + 1 });
          continue;
        }
        // A repeated prompt in old backlog is not the new turn if visible
        // messages follow it. Only the last visible prompt can prove a handoff.
        if (batch.events.length) next.candidate = null;
        // EOF is a prospective boundary only if no unverified user record or
        // omitted fragment was traversed and the last native write is complete.
        if (!batch.hasMore && batch.completeRecord && (Number.isSafeInteger(next.candidate) || (!next.userMessages && !next.omitted))) {
          await guard.write({ ...next, phase: 'ready', boundary: next.candidate ?? batch.cursor });
          break;
        }
        if (!batch.hasMore && next.uncertainFrom !== null) next.ambiguousFrom = next.uncertainFrom;
        await guard.write(next);
        if (!batch.hasMore) return pending('The current prompt could not be verified in native history. Retry after the host finishes writing; if it cannot record a blocked prompt, start a new host session and resume the intended Agent');
        if (batch.cursor === state.scanCursor) return pending(retryReason);
      }
      if (guard.value.phase === 'scan') return pending(retryReason);
    }
    if (guard?.value && (session.cursor ?? 0) > guard.value.boundary) return pending('Transcript cursor moved beyond the verified handoff boundary; no scope was changed');
    let result, userMessages = 0, omitted = false;
    for (let page = 0; page < 8; page += 1) {
      const batch = await readTranscriptBatch(input.transcript_path, input.session_id, session.cursor ?? 0, adapter,
        guard?.value ? { stopAtCursor: Math.max(session.cursor ?? 0, guard.value.ambiguousFrom ?? guard.value.boundary) } : { stopBeforePrompt: input.prompt ?? null });
      userMessages += batch.userMessages ?? 0; omitted ||= batch.omitted === true;
      // Without a durable guard, an unmatched user record cannot be attributed
      // to the prior owner merely because the file currently ends after it.
      if (!notRecorded && !guard && typeof input.prompt === 'string' && userMessages && !batch.atPromptBoundary) return pending(retryReason);
      const from = session.cursor ?? 0;
      result = await appendTranscriptPage(application, { ...scope, session_id: input.session_id,
        task_context_token: task.token, expected_cursor: from, cursor: batch.cursor,
        events: !notRecorded ? batch.events : batch.cursor > from ? [notRecordedEvent(from, batch.cursor, notRecorded)] : [] });
      if (result.status === 'saved') committedPages++;
      if (result.status === 'saved' && notRecorded && batch.cursor > from) skipped = true;
      if (!batch.hasMore && guard?.value?.ambiguousFrom !== undefined && batch.cursor < guard.value.boundary) {
        const boundary = guard.value.boundary;
        result = await appendTranscriptPage(application, { ...scope, session_id: input.session_id,
          task_context_token: task.token, expected_cursor: batch.cursor, cursor: boundary,
          events: [{ event_id: `jsonl-v1:${batch.cursor}:${boundary}:ambiguous`, role: 'tool', kind: 'tool_result',
            content: '[Visible transcript content omitted: ambiguous task ownership; original remains in native history.]' }] });
        batch.cursor = boundary;
      }
      if (!batch.hasMore) return { ...result, cursor: batch.cursor, ...(skipped ? { skipped: notRecorded } : {}),
        atPromptBoundary: Boolean(guard?.value || batch.atPromptBoundary || (typeof input.prompt === 'string' && !userMessages && !omitted && batch.completeRecord)),
        entryBlocked: Boolean(guard?.value && typeof input.prompt !== 'string'),
        coverage: 'supported_visible_events', parser: 'jsonl-v1', ...(guard?.value && typeof input.prompt !== 'string' ? { reason: retryReason } : {}) };
      if (batch.cursor === (session.cursor ?? 0)) break;
      session = { ...session, cursor: batch.cursor };
    }
    return pending(retryReason);
  } catch {
    return { status: committedPages ? 'partial' : 'unsaved', entryBlocked: typeof input.prompt === 'string',
      ...(!ownershipKnown ? { code: 'current_task_lookup_failed' } : {}),
      reason: committedPages ? 'Some transcript pages were saved before capture failed; the next hook resumes from committed progress'
        : 'Visible transcript capture could not be confirmed; native history will be retried at the next hook' };
  }
}

export async function recordTranscriptTaskEntry(guard, context) {
  if (!guard?.value) return;
  const token = context?.taskContextToken ?? context?.task_context_token;
  if (typeof token !== 'string' || !token) throw new Error('Task entry did not return its ownership token');
  await guard.write({ ...guard.value, phase: 'claim', nextOwner: transcriptDigest(token) });
}

export function withTranscriptNotice(output, sync) {
  if (!sync?.entryBlocked && !sync?.omitted && !['unsaved', 'partial'].includes(sync?.status)) return output;
  return { ...output, systemMessage: [output.systemMessage, `Fuli: ${sync.reason}.`].filter(Boolean).join('\n') };
}

// A scope switch is safe only after the old scope was flushed up to the current
// prompt. Failed flushes keep the old owner, so new Agents cannot inherit an
// unrelated session tail. Native files remain available for explicit recovery.
export async function claimTranscriptBoundary(application, input, sourceApplication, sync, adapter, guard = null) {
  if (!input.transcript_path) return sync;
  const capture = await captureDecision(application, transcriptCaptureScope(input, sourceApplication));
  if (!capture.allowed) return captureDisabled(capture);
  try {
    const task = await application.personal.currentTaskContext({ personal_space_id: application.config.personal.spaceId,
      session_id: input.session_id, source_application: sourceApplication });
    if (!task?.project_agent_id) return sync;
    const taskCapture = await captureDecision(application, taskTranscriptScope(input, sourceApplication, task));
    if (!taskCapture.allowed) return skippedTaskTranscript(application, input, sourceApplication, adapter, taskCapture, guard);
    if (guard?.value && (guard.value.phase !== 'claim' || guard.value.nextOwner !== transcriptDigest(task.token))) return pending('Transcript claim does not match the task entry that created it');
    const scope = { personal_space_id: application.config.personal.spaceId,
      personal_project_id: task.personal_project_id, agent_id: task.project_agent_id,
      source_application: sourceApplication, session_id: input.session_id };
    const policy = await application.personal.conversation('query', { ...scope, mode: 'policy' });
    if (!policy.enabled) return { status: 'capture_disabled' };
    const session = await application.personal.conversation('query', { ...scope, mode: 'session' });
    if (!session.initialized) {
      const cursor = await initialTranscriptBoundary(input.transcript_path, input.session_id, input.prompt, adapter);
      await application.personal.conversation('boundary', { ...scope, task_context_token: task.token,
        expected_cursor: 0, cursor, initialize_cursor: true });
      return { status: 'ready', coverage: 'from_current_task' };
    }
    if (sync?.status === 'saved' && sync.atPromptBoundary) {
      await application.personal.conversation('boundary', { ...scope, task_context_token: task.token,
        expected_cursor: sync.cursor, cursor: sync.cursor });
      await guard?.clear();
    }
    return sync;
  } catch {
    return { status: 'unsaved', entryBlocked: true, reason: 'Transcript boundary is unverified; saved task context is still available' };
  }
}
