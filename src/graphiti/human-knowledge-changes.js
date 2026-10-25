import { assertActivePersonalSpace } from './active-personal-space.js';
import { assertSafeKnowledgeMutation } from './knowledge-credential-guard.js';
import { recordAgentViews } from './agent-view-records.js';

export async function searchHumanChanges(application, {
  personalSpaceId,
  query = '',
  status = 'all',
  limit = 50,
  agentInvocation = false,
  agentToolName = 'search_human_knowledge_changes',
  sourceApplication = null
}) {
  assertActivePersonalSpace(application, personalSpaceId);
  const result = await application.personal.searchHumanChanges({
    personal_space_id: personalSpaceId,
    query,
    status,
    limit
  });
  if (agentInvocation) {
    await recordAgentViews(application,
      result.items.map(({ item_id: itemId, item_kind: itemKind }) => ({
        item_id: itemId,
        item_kind: itemKind
      })),
      agentToolName,
      { sourceApplication }
    );
  }
  return result;
}

export async function reviewHumanChange(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.reviewHumanChange(input.itemId, {
    personal_space_id: input.personalSpaceId,
    item_kind: input.itemKind,
    human_change_version: input.humanChangeVersion,
    conflict_check: input.conflictCheck,
    classification_check: input.classificationCheck,
    note: input.note
  });
}
