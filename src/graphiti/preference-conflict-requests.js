import { providerReaderFields, taskKnowledgeReader } from './knowledge-reader.js';
import { assertActivePersonalSpace } from './active-personal-space.js';
import { assertSafeKnowledgeMutation } from './knowledge-credential-guard.js';

// An Agent reads as a plain session: no conflict naming an FLA's own item (an FLA meets those in its
// task context). Only the console passes ownerReads (src/knowledge-owner-reads) for the full list.
export async function listPreferenceConflicts(application, { personalSpaceId, status = null, limit = 500 }, ownerReads = null) {
  assertActivePersonalSpace(application, personalSpaceId);
  return ownerReads
    ? ownerReads.preferenceConflicts({ personalSpaceId, status, limit })
    : application.personal.listPreferenceConflicts(personalSpaceId, status, limit);
}

// A conflict naming an item its reader may not see answers as missing: an Agent names its FLA
// (projectAgentId) or reads as a plain session; the console's defer and completion pass ownerReads.
export async function deferPreferenceConflict(application, input, ownerReads = null) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  const body = {
    personal_space_id: input.personalSpaceId,
    conflict_id: input.conflictId,
    preference_key: input.preferenceKey,
    preference_scope: input.preferenceScope,
    preference_project_id: input.preferenceProjectId ?? null,
    left_item_id: input.leftItemId,
    left_item_kind: input.leftItemKind,
    right_item_id: input.rightItemId,
    right_item_kind: input.rightItemKind,
    reason: input.reason,
    operation_actor: input.operationActor ?? 'human'
  };
  return ownerReads ? ownerReads.deferPreferenceConflict(body)
    : application.personal.deferPreferenceConflict({ ...body, ...providerReaderFields(taskKnowledgeReader(input)) });
}

export async function resolveDeferredPreferenceConflict(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.resolvePreferenceConflict(input.conflictId, {
    ...providerReaderFields(taskKnowledgeReader(input)),
    personal_space_id: input.personalSpaceId,
    resolution: input.resolution,
    reason: input.reason,
    canonical_item_id: input.canonicalItemId ?? null,
    merged_instruction: input.mergedInstruction ?? null,
    split_item_id: input.splitItemId ?? null,
    split_project_id: input.splitProjectId ?? null,
    operation_actor: input.operationActor ?? 'agent'
  });
}

export async function completePreferenceConflict(application, input, ownerReads = null) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  const body = { personal_space_id: input.personalSpaceId, resolution: input.resolution, reason: input.reason,
    operation_actor: input.operationActor ?? 'human' };
  return ownerReads ? ownerReads.completePreferenceConflict(input.conflictId, body)
    : application.personal.completePreferenceConflict(input.conflictId, body);
}
