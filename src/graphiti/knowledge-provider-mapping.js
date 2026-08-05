import { ApplicationError } from '../app/application-error.js';
import { onlineSourceUri } from './source-uri.js';

export function providerEpisode(input) {
  assertReasoningSummaries(input.entities, 'entities');
  assertReasoningSummaries(input.relationships, 'relationships');
  return {
    idempotency_key: input.idempotencyKey,
    session_id: input.sessionId,
    name: input.name,
    source_kind: input.sourceKind,
    source_description: input.sourceDescription,
    source_uri: onlineSourceUri(input.sourceUri),
    source_application: input.sourceApplication ?? null,
    source_turn_id: input.sourceTurnId ?? null,
    source_excerpt: input.sourceExcerpt ?? null,
    reference_time: input.referenceTime,
    summary: input.summary ?? '',
    sensitivity: input.sensitivity ?? 'normal',
    entities: input.entities.map((entity) => ({
      key: entity.key,
      name: entity.name,
      type: entity.type,
      summary: entity.summary ?? '',
      origin_quadrant: entity.originQuadrant ?? 'known_known',
      current_quadrant: entity.currentQuadrant ?? entity.originQuadrant ?? 'known_known',
      epistemic_status: entity.epistemicStatus ?? 'confirmed',
      confirmation_status: entity.confirmationStatus,
      confirmation_basis: providerConfirmationBasis(entity.confirmationBasis),
      reasoning_summary: entity.reasoningSummary ?? null,
      profile_aspect: entity.profileAspect ?? null,
      inheritance_mode: entity.inheritanceMode ?? 'local_only',
      inherited_project_ids: entity.inheritedProjectIds ?? [],
      attributes: entity.attributes ?? {}
    })),
    relationships: input.relationships.map((relationship) => ({
      key: relationship.key,
      source: relationship.source,
      target: relationship.target,
      type: relationship.type,
      fact: relationship.fact,
      valid_at: relationship.validAt ?? null,
      invalid_at: relationship.invalidAt ?? null,
      supersedes: relationship.supersedes ?? [],
      confidence: relationship.confidence ?? 1,
      origin_quadrant: relationship.originQuadrant ?? 'known_known',
      current_quadrant: relationship.currentQuadrant ??
        relationship.originQuadrant ?? 'known_known',
      epistemic_status: relationship.epistemicStatus ?? 'confirmed',
      confirmation_status: relationship.confirmationStatus,
      confirmation_basis: providerConfirmationBasis(relationship.confirmationBasis),
      reasoning_summary: relationship.reasoningSummary ?? null,
      profile_aspect: relationship.profileAspect ?? null,
      inheritance_mode: relationship.inheritanceMode ?? 'local_only',
      inherited_project_ids: relationship.inheritedProjectIds ?? [],
      attributes: relationship.attributes ?? {}
    }))
  };
}

function assertReasoningSummaries(items, collectionName) {
  items.forEach((item, index) => {
    const originQuadrant = item.originQuadrant ?? 'known_known';
    if (originQuadrant === 'known_known' || item.reasoningSummary?.trim()) return;
    throw new ApplicationError(
      'validation',
      `${collectionName}[${index}].reasoningSummary is required when ` +
      `originQuadrant is ${originQuadrant}`
    );
  });
}

export function assertPublicKnowledgeEligible(episode) {
  const blocked = [...episode.entities, ...episode.relationships].find((item) =>
    item.profile_aspect ||
    item.confirmation_status !== 'confirmed' ||
    !item.confirmation_basis?.confirmed_by ||
    !item.confirmation_basis?.confirmed_at ||
    !['user', 'authoritative_source'].includes(item.confirmation_basis.confirmed_by.kind)
  );
  if (blocked) {
    throw new TypeError(
      'Only knowledge with an auditable confirmation can enter public review'
    );
  }
}

export function providerConfirmationBasis(basis) {
  if (!basis) return undefined;
  return {
    existence_reason: basis.existenceReason,
    quadrant_reason: basis.quadrantReason,
    proposed_by: providerConfirmationActor(basis.proposedBy),
    confirmed_by: providerConfirmationActor(basis.confirmedBy),
    confirmed_at: basis.confirmedAt ?? null,
    agent_policy_version: basis.agentPolicyVersion ?? null
  };
}

export function providerConfirmationActor(actor) {
  if (!actor) return null;
  return {
    kind: actor.kind,
    label: actor.label ?? null
  };
}
