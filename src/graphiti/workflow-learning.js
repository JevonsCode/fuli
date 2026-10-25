import { captureDecision, captureDisabled } from './capture-decision.js';
import { assertActivePersonalSpace } from './active-personal-space.js';
import { assertNoCredentials } from './knowledge-credential-guard.js';
import {
  providerWorkflowCandidateSearch,
  workflowCandidatePage
} from './workflow-candidate-mapping.js';
import {
  providerWorkflowTransitionObservation
} from './workflow-observation.js';

export async function recordWorkflowTransitionObservation(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  const capture = await captureDecision(application, { sourceApplication: input.sourceApplication,
    personalProjectId: input.personalProjectId ?? null, sessionId: input.hostSessionId ?? null });
  if (!capture.allowed) return { route: 'disabled', ...captureDisabled(capture) };
  assertNoCredentials(input);
  const result = await application.personal.recordWorkflowObservation(
    providerWorkflowTransitionObservation(input)
  );
  return { route: 'personal', ...result };
}

export async function listWorkflowCandidates(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  const result = await application.personal.searchWorkflowCandidates(
    providerWorkflowCandidateSearch(input)
  );
  return workflowCandidatePage(result);
}

export async function recommendNextWorkflowSteps(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  const result = await application.personal.recommendWorkflowCandidates(
    providerWorkflowCandidateSearch(input)
  );
  return workflowCandidatePage(result);
}
