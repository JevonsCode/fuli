import { captureDecision, captureDisabled } from './capture-decision.js';
import { preflightTaskCaptures } from './task-knowledge-routing.js';
import { providerEpisode, providerPersonalCommit } from './knowledge-provider-mapping.js';
import { assertNoCredentials } from './knowledge-credential-guard.js';

// captureScope: the write's own scope when it differs from the target, as for
// a task checkpoint whose global preference was learned in the task's project.
export async function validateCaptureSessionKnowledge(application, input, { captureScope = knowledgeCaptureScope(input) } = {}) {
  if ((await captureDecision(application, captureScope)).allowed) prepareKnowledgeCapture(application, input);
}

export async function preflightPersonalKnowledgeCaptures(application, inputs) {
  return preflightTaskCaptures(application.personal, inputs, input => prepareKnowledgeCapture(application, input));
}

export async function captureSessionKnowledge(application, input, { captureScope = knowledgeCaptureScope(input) } = {}) {
  const capture = await captureDecision(application, captureScope);
  if (!capture.allowed) return { route: 'disabled', ...captureDisabled(capture) };
  const { commit } = prepareKnowledgeCapture(application, input);
  const result = await application.personal.commit(commit);
  return { route: 'personal', ...result };
}

function prepareKnowledgeCapture(application, input) {
  assertNoCredentials(input);
  const episode = providerEpisode(input);
  return { episode, commit: providerPersonalCommit(input, episode, application.config.personal.spaceId) };
}

function knowledgeCaptureScope(input) {
  return { sourceApplication: input?.sourceApplication, personalProjectId: input?.personalProjectId ?? null,
    sessionId: input?.sessionId ?? null };
}
