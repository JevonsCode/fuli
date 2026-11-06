import { acceptanceEvidence, verificationOf } from './verification.js';

// A task outcome's verification state, for its acceptance view: the
// exact-revision gate a verifier passed with evidence refs (tests, CI), the
// Tonborg acceptances that judged it, and a person who completed it. Read
// only; a task with none of these records is 尚未验证.
export async function taskVerification(app, { personalSpaceId, personalProjectId, taskId }) {
  const task = await app.viewProjectAgentTask({ personalSpaceId, personalProjectId, taskId, includeEvents: true });
  const evidence = [];
  if (task.qualityGate === 'passed' && task.verifiedArtifactRevision) {
    const gate = await app.agentVerification('query', { personalProjectId: task.personalProjectId, taskId,
      artifactRevision: task.verifiedArtifactRevision });
    const attempt = gate.verified_attempt;
    if (gate.status === 'passed' && attempt?.outcome === 'pass' && attempt.evidence_refs?.length) {
      evidence.push({ state: 'auto_verified', source: 'verification', ref: attempt.attempt_id, refs: attempt.evidence_refs, taskId });
    }
  }
  if (app.judgment) evidence.push(...(await app.judgment.acceptanceOutcomes({ personalSpaceId, taskId })).flatMap(acceptanceEvidence));
  for (const event of task.events ?? []) {
    if (event.actorKind === 'human' && event.status === 'completed') {
      evidence.push({ state: 'person_confirmed', source: 'person', ref: event.eventId, taskId, at: event.createdAt ?? null });
    }
  }
  return { taskId, ...verificationOf(evidence) };
}
