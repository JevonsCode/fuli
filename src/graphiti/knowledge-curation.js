import {
  providerConfirmationActor,
  providerConfirmationBasis
} from './knowledge-provider-mapping.js';
import { assertActivePersonalSpace } from './active-personal-space.js';
import { assertSafeKnowledgeMutation } from './knowledge-credential-guard.js';
import { InvalidInputError } from '../app/application-error.js';
import { preferenceCondition } from '../conversations/preference-conditions.js';

export async function recordKnowledgeUsage(application, {
  personalSpaceId,
  taskId,
  sessionId = null,
  toolName = null,
  items
}) {
  assertActivePersonalSpace(application, personalSpaceId);
  return application.personal.recordKnowledgeUsage({
    personal_space_id: personalSpaceId,
    task_id: taskId,
    session_id: sessionId,
    tool_name: toolName,
    items: items.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      use_kind: item.useKind
    }))
  });
}

// A change the console sends as the person's own goes on its human-review
// port (ownerReads, src/knowledge-owner-reads): the provider refuses
// operation_actor 'human' on the access token alone.
const changeChannel = (application, input, ownerReads) =>
  (input.operationActor === 'human' && ownerReads ? ownerReads : application.personal);

export async function reviseKnowledgeItem(application, input, ownerReads = null) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  const body = {
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId ?? null,
    item_kind: input.itemKind,
    action: input.action,
    reason: input.reason,
    name: input.name ?? null,
    summary: input.summary ?? null,
    fact: input.fact ?? null,
    basis_meaning: input.basisMeaning ?? null, // D-20.7, a person's choice only
    operation_actor: input.operationActor ?? 'agent',
    // The version the editor read (rec#20); the Provider refuses a stale one.
    ...(input.expectedVersion !== undefined ? { expected_version: input.expectedVersion } : {})
  };
  if (input.currentQuadrant !== undefined) {
    body.current_quadrant = input.currentQuadrant;
  }
  if (input.originQuadrant !== undefined) {
    body.origin_quadrant = input.originQuadrant;
  }
  if (input.epistemicStatus !== undefined) {
    body.epistemic_status = input.epistemicStatus;
  }
  if (input.confirmationStatus !== undefined) {
    body.confirmation_status = input.confirmationStatus;
  }
  if (input.confirmationBasis !== undefined) {
    body.confirmation_basis = providerConfirmationBasis(input.confirmationBasis);
  }
  if (input.reasoningSummary !== undefined) {
    body.reasoning_summary = input.reasoningSummary;
  }
  if (input.profileAspect !== undefined) {
    body.profile_aspect = input.profileAspect;
  }
  if (input.inheritanceMode !== undefined) {
    body.inheritance_mode = input.inheritanceMode;
  }
  if (input.inheritedProjectIds !== undefined) {
    body.inherited_project_ids = input.inheritedProjectIds;
  }
  if (input.replacementItemId !== undefined) {
    body.replacement_item_id = input.replacementItemId;
  }
  if (input.replacementItemKind !== undefined) {
    body.replacement_item_kind = input.replacementItemKind;
  }
  if (input.appliesWhen !== undefined) {
    body.applies_when = input.appliesWhen;
  }
  return changeChannel(application, input, ownerReads).reviseKnowledgeItem(input.itemId, body);
}

// When a habit applies (appliesWhen, #1104), set or cleared: the person's own
// decision, made in the console or relayed in their words (`relay`, quoted
// in the revision's reason). The habit keeps its text, its confirmation and
// its version; the revision keeps the case it had. A case that means every
// task (「总是」「所有任务」, preference-conditions.js) is no case, so it clears.
const CASE_CHARS = 200;

export async function setPreferenceAppliesWhen(application, input, ownerReads = null, relay = null) {
  const said = input.appliesWhen ?? '';
  if (typeof said !== 'string' || said.length > CASE_CHARS) {
    throw new InvalidInputError(`appliesWhen is the case in a few words, at most ${CASE_CHARS} characters, or empty to clear it`);
  }
  const stated = preferenceCondition({ preference_qualifiers: { appliesWhen: said } }) ? said.trim() : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  return reviseKnowledgeItem(application, {
    personalSpaceId: input.personalSpaceId, itemKind: input.itemKind, itemId: input.itemId, action: 'update',
    appliesWhen: stated, operationActor: input.operationActor,
    reason: relay ? `${reason}（由 ${relay.relayedBy ?? 'FLA'} 转达：「${relay.personWords}」）` : reason
  }, ownerReads);
}

export async function confirmKnowledgeBatch(application, input, ownerReads = null) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return changeChannel(application, input, ownerReads).confirmKnowledgeBatch({
    personal_space_id: input.personalSpaceId,
    group_kind: input.groupKind,
    group_value: input.groupValue,
    reason: input.reason,
    confirmer: providerConfirmationActor(input.confirmer),
    operation_actor: input.operationActor ?? 'agent',
    items: input.items.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      existence_reason: item.existenceReason,
      quadrant_reason: item.quadrantReason,
      proposed_by: providerConfirmationActor(item.proposedBy)
    }))
  });
}

export async function reassignKnowledgeItem(application, input, ownerReads = null) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  return changeChannel(application, input, ownerReads).reassignKnowledgeItem(input.itemId, {
    personal_space_id: input.personalSpaceId,
    item_kind: input.itemKind,
    target_project_id: input.targetProjectId,
    reason: input.reason,
    operation_actor: input.operationActor ?? 'agent'
  });
}

export async function setPersonalPreferenceScope(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.setPreferenceScope(input.itemId, {
    personal_space_id: input.personalSpaceId,
    item_kind: input.itemKind,
    scope: input.scope,
    project_id: input.scope === 'project' ? input.projectId : null,
    reason: input.reason,
    operation_actor: input.operationActor ?? 'agent'
  });
}

export async function previewKnowledgeProjectAction(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  return application.personal.previewKnowledgeProjectAction(input.itemId, {
    personal_space_id: input.personalSpaceId,
    item_kind: input.itemKind,
    mode: input.mode ?? 'existing',
    target_project_id: input.targetProjectId ?? null,
    new_project_id: input.newProjectId ?? null,
    new_project_name: input.newProjectName ?? null,
    new_project_purpose: input.newProjectPurpose ?? null,
    keep_source_relation: input.keepSourceRelation ?? true,
    relation_type: input.relationType ?? 'RELATED_TO',
    conflict_resolution: input.conflictResolution ?? 'defer',
    reason: input.reason ?? null
  });
}

export async function applyKnowledgeProjectAction(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.applyKnowledgeProjectAction(input.itemId, {
    personal_space_id: input.personalSpaceId,
    item_kind: input.itemKind,
    mode: input.mode,
    target_project_id: input.targetProjectId ?? null,
    new_project_id: input.newProjectId ?? null,
    new_project_name: input.newProjectName ?? null,
    new_project_purpose: input.newProjectPurpose ?? null,
    keep_source_relation: input.keepSourceRelation ?? true,
    relation_type: input.relationType ?? 'RELATED_TO',
    conflict_resolution: input.conflictResolution ?? 'defer',
    reason: input.reason,
    operation_actor: input.operationActor ?? 'agent'
  });
}
