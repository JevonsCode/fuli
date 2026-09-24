import { initialTranscriptBoundary, readTranscriptBatch } from './transcript-reader.js';
import { transcriptDigest } from './transcript-guard.js';

const pending = reason => ({ status: 'partial', entryBlocked: true, reason });
const retryReason = 'Transcript handoff is pending. Retry task entry to continue its saved progress; no new Agent context was supplied';

export async function syncConversationTranscript(application, input, sourceApplication, adapter, guard = null) {
  if (!application.getCapturePolicy?.().enabled) return { status: 'capture_disabled' };
  if (!input?.transcript_path) return { status: 'partial', reason: 'Host did not supply a visible transcript' };
  let committedPages = 0;
  try {
    const task = await application.personal.currentTaskContext({ personal_space_id: application.config.personal.spaceId,
      session_id: input.session_id, source_application: sourceApplication });
    if (!task?.project_agent_id) return guard?.value ? pending(retryReason) : { status: 'unassigned' };
    const scope = { personal_space_id: application.config.personal.spaceId, personal_project_id: task.personal_project_id,
      agent_id: task.project_agent_id, source_application: sourceApplication };
    const policy = await application.personal.conversation('query', { ...scope, mode: 'policy' });
    if (!policy.enabled) return { status: 'capture_disabled' };
    let session = await application.personal.conversation('query', { ...scope, mode: 'session', session_id: input.session_id });
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
        const batch = await readTranscriptBatch(input.transcript_path, input.session_id, state.scanCursor, adapter,
          { stopBeforeDigest: state.prompt });
        const next = { ...state, scanCursor: batch.cursor,
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
      if (!guard && typeof input.prompt === 'string' && userMessages && !batch.atPromptBoundary) return pending(retryReason);
      result = await application.personal.conversation('append', { ...scope, session_id: input.session_id,
        task_context_token: task.token, events: batch.events, expected_cursor: session.cursor ?? 0, cursor: batch.cursor });
      if (result.status === 'saved') committedPages++;
      if (!batch.hasMore && guard?.value?.ambiguousFrom !== undefined && batch.cursor < guard.value.boundary) {
        const boundary = guard.value.boundary;
        result = await application.personal.conversation('append', { ...scope, session_id: input.session_id,
          task_context_token: task.token, expected_cursor: batch.cursor, cursor: boundary,
          events: [{ event_id: `jsonl-v1:${batch.cursor}:${boundary}:ambiguous`, role: 'tool', kind: 'tool_result',
            content: '[Visible transcript content omitted: ambiguous task ownership; original remains in native history.]' }] });
        batch.cursor = boundary;
      }
      if (!batch.hasMore) return { ...result, cursor: batch.cursor,
        atPromptBoundary: Boolean(guard?.value || batch.atPromptBoundary || (typeof input.prompt === 'string' && !userMessages && !omitted && batch.completeRecord)),
        entryBlocked: Boolean(guard?.value && typeof input.prompt !== 'string'),
        coverage: 'supported_visible_events', parser: 'jsonl-v1', ...(guard?.value && typeof input.prompt !== 'string' ? { reason: retryReason } : {}) };
      if (batch.cursor === (session.cursor ?? 0)) break;
      session = { ...session, cursor: batch.cursor };
    }
    return pending(retryReason);
  } catch {
    return { status: committedPages ? 'partial' : 'unsaved', entryBlocked: typeof input.prompt === 'string',
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
  if (!sync?.entryBlocked && !['unsaved', 'partial'].includes(sync?.status)) return output;
  return { ...output, systemMessage: [output.systemMessage, `Fuli: ${sync.reason}.`].filter(Boolean).join('\n') };
}

// A scope switch is safe only after the old scope was flushed up to the current
// prompt. Failed flushes keep the old owner, so new Agents cannot inherit an
// unrelated session tail. Native files remain available for explicit recovery.
export async function claimTranscriptBoundary(application, input, sourceApplication, sync, adapter, guard = null) {
  if (!application.getCapturePolicy?.().enabled || !input.transcript_path) return sync;
  try {
    const task = await application.personal.currentTaskContext({ personal_space_id: application.config.personal.spaceId,
      session_id: input.session_id, source_application: sourceApplication });
    if (!task?.project_agent_id) return sync;
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
