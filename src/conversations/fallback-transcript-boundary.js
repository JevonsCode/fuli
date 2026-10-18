import { transcriptDigest } from './transcript-guard.js';
import { verifiedTranscriptEnd } from './transcript-reader.js';
import { lookupTranscriptTask } from './current-task-lookup.js';

// A fresh model fallback can supersede a blocked Hook task. Only the Provider's
// exact native session provenance admits recovery; token mismatch alone cannot.
export async function recoverFallbackTranscript(application, input, source, adapter, guard, task, session, { freshEntry = false } = {}) {
  if (!guard || (!guard.value && !freshEntry) || (task.entry_via !== 'tool' && !(freshEntry && task.entry_via === 'hook'))
    || task.session_id !== input.session_id || task.source_application !== source
    || task.personal_space_id !== application.config.personal.spaceId) return null;
  const owner = transcriptDigest(task.token);
  if (!freshEntry && guard.value.owner === owner && guard.value.phase !== 'fallback') return null;
  if (!freshEntry && guard.value.phase === 'claim' && guard.value.nextOwner === owner) return null;
  const end = await verifiedTranscriptEnd(input.transcript_path, input.session_id, adapter);
  if ((session.cursor ?? 0) > end) throw new Error('Native transcript was truncated');
  const saved = guard.value?.phase === 'fallback' && guard.value.nextOwner === owner
    && guard.value.boundary === end ? guard.value : null;
  const from = saved?.recoveryFrom ?? session.cursor ?? 0;
  await guard.write({ version: 1, owner, prompt: transcriptDigest(input.prompt ?? ''), scanCursor: from,
    ...guard.value, phase: 'fallback', nextOwner: owner,
    recoveryFrom: from, boundary: end });
  const result = await application.personal.conversation('boundary', {
    personal_space_id: task.personal_space_id, personal_project_id: task.personal_project_id,
    agent_id: task.project_agent_id, source_application: source, session_id: input.session_id,
    task_context_token: task.token, expected_cursor: from, cursor: end, fallback_recovery: true
  });
  if (result.status !== 'saved') throw new Error('Fallback omission was not committed');
  await guard.clear();
  return { ...result, cursor: end, atPromptBoundary: true, omitted: true,
    coverage: 'fallback_boundary_only', parser: 'jsonl-v1',
    reason: 'The unverified native interval after fallback was marked not imported; capture resumes from the current tail' };
}

// A failed Hook import may still create and deliver a fresh task. Quarantine
// the old interval only after re-reading that exact token/session from the
// Provider and verifying the native file's identity and complete EOF.
export async function recoverFailedTranscriptEntry(application, input, source, adapter, guard, context) {
  const expected = context.taskContextToken ?? context.task_context_token;
  if (!expected) return null;
  const { task, failure } = await lookupTranscriptTask(application, input, source);
  if (failure || task?.token !== expected || !task.project_agent_id) return null;
  const scope = { personal_space_id: application.config.personal.spaceId, personal_project_id: task.personal_project_id,
    agent_id: task.project_agent_id, source_application: source };
  const policy = await application.personal.conversation('query', { ...scope, mode: 'policy' });
  if (!policy.enabled) return null;
  const session = await application.personal.conversation('query', { ...scope, mode: 'session', session_id: input.session_id });
  return recoverFallbackTranscript(application, input, source, adapter, guard, task, session, { freshEntry: true });
}
