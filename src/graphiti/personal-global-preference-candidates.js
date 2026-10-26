import { createHash } from 'node:crypto';

import {
  commonKnowledgeItem, commonKnowledgeSimilarity, preferenceContentTokens, sharedPreferenceTerms
} from './cross-project-knowledge-similarity.js';

export async function discoverPersonalGlobalPreferenceCandidates(application, {
  personalSpaceId,
  personalProjectIds,
  query,
  minProjects = 2,
  similarityThreshold = 0.72,
  limitPerProject = 12
}) {
  if (!Array.isArray(personalProjectIds) || personalProjectIds.length < 2) {
    throw new TypeError('Personal-global candidates need at least two explicit projects');
  }
  if (!Number.isInteger(minProjects) || minProjects < 2) {
    throw new TypeError('Personal-global candidates need evidence from at least two projects');
  }
  if (
    typeof similarityThreshold !== 'number'
    || similarityThreshold < 0
    || similarityThreshold > 1
  ) {
    throw new TypeError('Similarity threshold must be between 0 and 1');
  }
  const projectIds = [...new Set(personalProjectIds)].sort();
  if (projectIds.length < 2 || minProjects > projectIds.length) {
    throw new TypeError('The selected project set cannot satisfy minProjects');
  }
  const knownProjectIds = new Set(
    (await application.personal.listPersonalProjects(personalSpaceId))
      .map(({ project_id: projectId }) => projectId)
  );
  if (projectIds.some((projectId) => !knownProjectIds.has(projectId))) {
    throw new TypeError('Every selected project must exist in the active personal space');
  }

  const projectResults = await Promise.all(projectIds.map(async (projectId) => ({
    projectId,
    result: await application.personal.search({
      space_ids: [personalSpaceId],
      query,
      limit: limitPerProject,
      include_historical: false,
      include_exploratory: false,
      personal_project_ids: [projectId],
      active_personal_project_id: projectId,
      inherit_project_knowledge: false,
      include_personal_global: false
    })
  })));
  const items = projectResults.flatMap(({ projectId, result }) => [
    ...(result.entities ?? []).map((item) =>
      commonKnowledgeItem(item, 'entity', projectId)
    ),
    ...(result.facts ?? []).map((item) =>
      commonKnowledgeItem(item, 'relationship', projectId)
    )
  ]).filter((item) =>
    item.profile_aspect
    && item.preference_scope === 'project'
    && item.preference_project_id === item.defined_project_id
    && ['confirmed', 'agent_confirmed'].includes(item.confirmation_status)
    && item.requires_attention !== true
  );
  const clusteredCandidates = clusterPersonalGlobalPreferenceItems(
    items,
    minProjects,
    similarityThreshold,
    query,
    projectIds.length
  );
  const candidates = await Promise.all(clusteredCandidates.map(async (candidate) => {
    const options = await application.personal.personalGlobalPreferenceScopeOptions(
      candidate.candidate_id,
      {
        personal_space_id: personalSpaceId,
        source_items: candidate.source_items.map((item) => ({
          item_id: item.id,
          item_kind: item.item_kind,
          project_id: item.defined_project_id
        })),
        preference_key: candidate.preference_key
      }
    );
    return {
      ...candidate,
      candidate_version: options.candidate_version,
      target_scope: 'human_selected',
      eligible_target_scopes: options.eligible_target_scopes,
      source_snapshots: options.source_snapshots
    };
  }));
  const decisionState = await personalGlobalCandidateDecisionState(
    application,
    personalSpaceId,
    candidates
  );
  const visibleCandidates = candidates
    .filter(({ candidate_id: id, candidate_version: version }) =>
      !decisionState.decisions.has(`${id}:${version}`)
    )
    .map((candidate) => personalGlobalCandidateWithDecisionState(
      candidate,
      decisionState.revisions.get(candidate.candidate_id)
    ));
  const suppressedCandidates = candidates
    .filter(({ candidate_id: id, candidate_version: version }) =>
      decisionState.decisions.has(`${id}:${version}`)
    )
    .map(({ candidate_id: candidateId, candidate_version: version }) => ({
      candidate_id: candidateId,
      candidate_version: version,
      ...decisionState.decisions.get(`${candidateId}:${version}`)
    }));
  return {
    status: visibleCandidates.length > 0
      ? 'candidates_found'
      : suppressedCandidates.length > 0
        ? 'candidates_suppressed'
        : 'no_candidates',
    personal_space_id: personalSpaceId,
    target_scope: 'human_selected',
    selected_project_ids: projectIds,
    query,
    candidates: visibleCandidates,
    suppressed_candidates: suppressedCandidates,
    policy: personalGlobalCandidatePolicy()
  };
}

export async function previewPersonalGlobalPreferenceDecision(application, input) {
  return application.personal.inspectPersonalGlobalPreferenceDecision(
    input.candidateId,
    providerPersonalGlobalPreferenceDecision(input)
  );
}

export async function applyPersonalGlobalPreferenceDecision(application, input) {
  return application.personal.applyPersonalGlobalPreferenceDecision(
    input.candidateId,
    providerPersonalGlobalPreferenceDecision(input, {
      approvalToken: input.previewToken
    })
  );
}

function clusterPersonalGlobalPreferenceItems(
  items,
  minProjects,
  similarityThreshold,
  query,
  selectedProjectCount
) {
  const groups = [];
  for (const item of items) {
    const preferenceKey = personalGlobalItemPreferenceKey(item);
    const matching = groups
      .map((group) => ({
        group,
        similarity: Math.min(
          ...group.items.map((member) => commonKnowledgeSimilarity(item, member))
        )
      }))
      .filter(({ group, similarity }) =>
        group.itemKind === item.item_kind
        && group.preferenceKey === preferenceKey
        && similarity >= similarityThreshold
        && !group.projectIds.has(item.defined_project_id)
      )
      .sort((left, right) => right.similarity - left.similarity)[0];
    if (matching) {
      matching.group.items.push(item);
      matching.group.projectIds.add(item.defined_project_id);
      continue;
    }
    groups.push({
      itemKind: item.item_kind,
      preferenceKey,
      projectIds: new Set([item.defined_project_id]),
      items: [item]
    });
  }

  return groups
    .filter(({ projectIds }) => projectIds.size >= minProjects)
    .map((group) => {
      const sourceItems = [...group.items].sort((left, right) =>
        left.defined_project_id.localeCompare(right.defined_project_id)
      );
      const itemIds = sourceItems.map(({ id }) => id).sort();
      const commonTerms = sharedPreferenceTerms(sourceItems);
      const pairScores = [];
      for (let left = 0; left < sourceItems.length; left += 1) {
        for (let right = left + 1; right < sourceItems.length; right += 1) {
          pairScores.push(commonKnowledgeSimilarity(
            sourceItems[left],
            sourceItems[right]
          ));
        }
      }
      const averageSimilarity = pairScores.length === 0
        ? 1
        : pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
      const ranking = personalGlobalCandidateRanking({
        sourceItems,
        projectCount: group.projectIds.size,
        selectedProjectCount,
        lexicalSimilarity: averageSimilarity
      });
      return {
        candidate_id: personalGlobalPreferenceCandidateId(itemIds),
        candidate_version: null,
        target_scope: 'human_selected',
        source_project_ids: [...group.projectIds].sort(),
        item_kind: group.itemKind,
        preference_key: group.preferenceKey,
        query,
        similarity_score: Number(averageSimilarity.toFixed(4)),
        similarity_basis: 'lexical_overlap_across_explicit_personal_projects',
        candidate_score: ranking.score,
        ranking,
        source_items: sourceItems,
        derived_common_core: {
          terms: commonTerms,
          basis: 'lexical_intersection_of_preserved_source_text',
          authoritative: false,
          source_item_ids: itemIds
        },
        source_specific_terms: sourceItems.map((item) => ({
          item_id: item.id,
          project_id: item.defined_project_id,
          terms: [...preferenceContentTokens(item)]
            .filter((term) => !commonTerms.includes(term))
            .sort()
        })),
        requires_human_scope_judgment: true,
        scope_apply_performed: false
      };
    })
    .sort((left, right) =>
      right.candidate_score - left.candidate_score
      || right.source_project_ids.length - left.source_project_ids.length
      || right.similarity_score - left.similarity_score
      || left.candidate_id.localeCompare(right.candidate_id)
    );
}

function personalGlobalItemPreferenceKey(item) {
  return item.preference_key
    ?? item.attributes?.preferenceKey
    ?? item.attributes?.preference_key
    ?? item.key
    ?? item.id;
}

const PERSONAL_GLOBAL_RANKING_WEIGHTS = Object.freeze({
  distinct_projects: 0.25,
  lexical_similarity: 0.35,
  confirmation_authority: 0.2,
  recency: 0.1,
  negative_evidence: 0.1
});

function personalGlobalCandidateRanking({
  sourceItems,
  projectCount,
  selectedProjectCount,
  lexicalSimilarity
}) {
  const signals = {
    distinct_projects: boundedScore(
      projectCount / Math.max(selectedProjectCount, 1)
    ),
    lexical_similarity: boundedScore(lexicalSimilarity),
    confirmation_authority: averageScore(sourceItems.map((item) =>
      item.confirmation_status === 'confirmed' ? 1 : 0.65
    )),
    recency: averageScore(sourceItems.map(personalGlobalItemRecency)),
    negative_evidence: averageScore(sourceItems.map((item) =>
      item.requires_attention === true
        ? 0
        : 1 / (1 + Math.max(0, Number(item.negative_evidence_count ?? 0)))
    ))
  };
  const details = Object.fromEntries(
    Object.entries(signals).map(([key, value]) => {
      const weight = PERSONAL_GLOBAL_RANKING_WEIGHTS[key];
      return [key, {
        value: Number(value.toFixed(4)),
        weight,
        contribution: Number((value * weight).toFixed(4))
      }];
    })
  );
  const score = Object.values(details)
    .reduce((sum, signal) => sum + signal.contribution, 0);
  return {
    score: Number(score.toFixed(4)),
    signals: details,
    source_project_count: projectCount,
    selected_project_count: selectedProjectCount,
    policy: 'ranking_only_never_changes_scope_or_confirmation_authority'
  };
}

function personalGlobalItemRecency(item) {
  const timestamp = [
    item.last_used_at,
    item.last_human_changed_at,
    item.created_at
  ].map((value) => Date.parse(value ?? ''))
    .find(Number.isFinite);
  if (!Number.isFinite(timestamp)) return 0.5;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return Math.exp(-ageDays / 180);
}

function averageScore(values) {
  if (values.length === 0) return 0;
  return boundedScore(
    values.reduce((sum, value) => sum + value, 0) / values.length
  );
}

function boundedScore(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function personalGlobalCandidatePolicy() {
  return {
    read_only: true,
    exact_projects_only: true,
    inherited_knowledge_excluded: true,
    personal_global_excluded: true,
    original_text_and_sources_preserved: true,
    derived_core_is_non_authoritative: true,
    human_scope_judgment_required: true,
    automatic_scope_apply: false,
    ranking_scores_are_non_authoritative: true,
    stale_decisions_do_not_suppress_changed_candidates: true
  };
}

async function personalGlobalCandidateDecisionState(
  application,
  personalSpaceId,
  candidates
) {
  if (candidates.length === 0) {
    return { decisions: new Map(), revisions: new Map() };
  }
  const result = await application.personal
    .personalGlobalPreferenceDecisionStatus({
      personal_space_id: personalSpaceId,
      candidates: candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        candidate_version: candidate.candidate_version
      }))
    });
  return {
    decisions: new Map((result.decisions ?? []).map((decision) => [
      `${decision.candidate_id}:${decision.candidate_version}`,
      {
        decision: decision.decision,
        decision_event_id: decision.decision_event_id,
        decision_revision: decision.decision_revision,
        target_scope: decision.target_scope,
        target_project_id: decision.target_project_id ?? null,
        global_assertion_id: decision.global_assertion_id,
        global_assertion_active: decision.global_assertion_active
      }
    ])),
    revisions: new Map((result.revisions ?? []).map((revision) => [
      revision.candidate_id,
      revision
    ]))
  };
}

function personalGlobalCandidateWithDecisionState(candidate, revision) {
  const decisionRevision = revision?.decision_revision ?? 0;
  const previousVersion = revision?.current_candidate_version ?? null;
  const sourceDrift = Boolean(
    previousVersion && previousVersion !== candidate.candidate_version
  );
  return {
    ...candidate,
    decision_revision: decisionRevision,
    prior_decision_source_drift: sourceDrift,
    prior_decision_candidate_version: sourceDrift ? previousVersion : null,
    fresh_human_review_required: true
  };
}

function providerPersonalGlobalPreferenceDecision(input, {
  approvalToken = null
} = {}) {
  const result = {
    personal_space_id: input.personalSpaceId,
    candidate_version: input.candidateVersion,
    decision_revision: input.decisionRevision,
    source_items: input.sourceItems.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      project_id: item.projectId
    })),
    preference_key: input.preferenceKey,
    target_scope: input.targetScope,
    target_project_id: input.targetProjectId ?? null,
    decision: input.decision,
    global_title: input.globalTitle ?? null,
    global_instruction: input.globalInstruction ?? null,
    profile_aspect: input.profileAspect ?? null,
    human_confirmation_reason: input.humanConfirmationReason,
    confirmed_at: input.confirmedAt,
    session_id: input.sessionId,
    idempotency_key: input.idempotencyKey
  };
  if (approvalToken) result.approval_token = approvalToken;
  return result;
}

function personalGlobalPreferenceCandidateId(itemIds) {
  return `personal-global-${createHash('sha256')
    .update([...itemIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 20)}`;
}
