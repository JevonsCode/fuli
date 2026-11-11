import { assertActivePersonalSpace } from './active-personal-space.js';
import {
  providerWorkflowCandidateSearch,
  workflowCandidatePage
} from './workflow-candidate-mapping.js';

export async function listWorkflowCandidates(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  const result = await application.personal.searchWorkflowCandidates(
    providerWorkflowCandidateSearch(input)
  );
  return workflowCandidatePage(result);
}
