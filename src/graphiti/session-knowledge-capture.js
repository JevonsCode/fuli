import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { captureDecision, captureDisabled } from './capture-decision.js';
import { preflightTaskCaptures } from './task-knowledge-routing.js';
import {
  assertPublicKnowledgeEligible,
  providerEpisode,
  providerPersonalCommit
} from './knowledge-provider-mapping.js';
import { queuePublicationDraft } from './publication-draft-capture.js';
import { assertNoCredentials } from './knowledge-credential-guard.js';
import { configuredWorkspace } from './workspace-provider-client.js';

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
  const { episode, workspace, commit } = prepareKnowledgeCapture(application, input);
  if (input.targetKind === 'personal') {
    const result = await application.personal.commit(commit);
    return { route: 'personal', ...result };
  }
  return queuePublicationDraft(application, { input, workspace, episode });
}

function prepareKnowledgeCapture(application, input) {
  assertNoCredentials(input);
  const episode = providerEpisode(input);
  if (input.targetKind === 'personal') {
    return { episode, commit: providerPersonalCommit(input, episode, application.config.personal.spaceId) };
  }
  if (input.projectAgentId) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      'Project Agent knowledge can only be captured in the personal graph'
    );
  }
  if (episode.sensitivity !== 'normal') {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      'Private or restricted knowledge cannot enter a team-shared project queue. Use targetKind "personal" with personalProjectId to keep it in the personal graph'
    );
  }
  assertPublicKnowledgeEligible(episode);
  return { episode, workspace: configuredWorkspace(application.workspaces, input.providerUrl) };
}

function knowledgeCaptureScope(input) {
  return { sourceApplication: input?.sourceApplication, personalProjectId: input?.personalProjectId ?? null,
    sessionId: input?.sessionId ?? null };
}
