import { providerCommonKnowledgePromotion } from './agent-knowledge-workflows.js';
import {
  providerConfirmationActor,
  providerConfirmationBasis
} from './knowledge-provider-mapping.js';
import { assertActivePersonalSpace } from './active-personal-space.js';
import { assertSafeKnowledgeMutation } from './knowledge-credential-guard.js';

export async function previewCommonKnowledgePromotion(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.previewCommonKnowledgePromotion(
    providerCommonKnowledgePromotion(input)
  );
}

export async function applyCommonKnowledgePromotion(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.applyCommonKnowledgePromotion({
    ...providerCommonKnowledgePromotion(input),
    operation_actor: input.operationActor ?? 'agent'
  });
}

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

export async function reviseKnowledgeItem(application, input) {
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
  return application.personal.reviseKnowledgeItem(input.itemId, body);
}

export async function confirmKnowledgeBatch(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  assertSafeKnowledgeMutation(input);
  return application.personal.confirmKnowledgeBatch({
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

export async function reassignKnowledgeItem(application, input) {
  assertActivePersonalSpace(application, input.personalSpaceId);
  return application.personal.reassignKnowledgeItem(input.itemId, {
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
