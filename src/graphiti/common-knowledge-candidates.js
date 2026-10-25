import { createHash } from 'node:crypto';

import { commonKnowledgeItem, commonKnowledgeSimilarity } from './cross-project-knowledge-similarity.js';

export async function discoverCommonKnowledgeCandidates(application, {
  personalSpaceId,
  parentProjectId,
  query,
  minChildProjects = 2,
  similarityThreshold = 0.72,
  limitPerProject = 12
}) {
  if (!Number.isInteger(minChildProjects) || minChildProjects < 2) {
    throw new TypeError('Common knowledge needs evidence from at least two child projects');
  }
  if (
    typeof similarityThreshold !== 'number'
    || similarityThreshold < 0
    || similarityThreshold > 1
  ) {
    throw new TypeError('Similarity threshold must be between 0 and 1');
  }

  const graph = await application.personal.graph(personalSpaceId, 2000);
  const projectIdByNodeId = new Map(
    (graph.nodes ?? [])
      .filter(({ type }) => type === 'PersonalProject')
      .map((node) => [node.id, node.attributes?.projectId])
      .filter(([, projectId]) => typeof projectId === 'string' && projectId)
  );
  if (![...projectIdByNodeId.values()].includes(parentProjectId)) {
    throw new TypeError('Parent project is not present in the active personal graph');
  }
  const childProjectIds = [...new Set(
    (graph.edges ?? [])
      .filter(({ type, source, target, attributes = {} }) =>
        type === 'PART_OF'
        && attributes.status === 'active'
        && (
          attributes.confirmationAuthority
          ?? attributes.confirmation_authority
        ) === 'human_review'
        && projectIdByNodeId.get(target) === parentProjectId
        && projectIdByNodeId.has(source)
      )
      .map(({ source }) => projectIdByNodeId.get(source))
  )].sort();

  if (childProjectIds.length < minChildProjects) {
    return commonCandidateResult({
      status: childProjectIds.length === 0 ? 'no_children' : 'insufficient_children',
      personalSpaceId,
      parentProjectId,
      childProjectIds,
      query,
      candidates: [],
      graph
    });
  }

  const childResults = await Promise.all(childProjectIds.map(async (projectId) => ({
    projectId,
    result: await application.personal.search({
      space_ids: [personalSpaceId],
      query,
      limit: limitPerProject,
      include_historical: false,
      include_exploratory: true,
      personal_project_ids: [projectId],
      active_personal_project_id: projectId,
      inherit_project_knowledge: false,
      include_personal_global: false
    })
  })));
  const items = childResults.flatMap(({ projectId, result }) => [
    ...(result.entities ?? []).map((item) =>
      commonKnowledgeItem(item, 'entity', projectId)
    ),
    ...(result.facts ?? []).map((item) =>
      commonKnowledgeItem(item, 'relationship', projectId)
    )
  ]).filter((item) => !item.profile_aspect);
  const candidates = clusterCommonKnowledgeItems(
    items,
    minChildProjects,
    similarityThreshold,
    parentProjectId,
    query
  );
  return commonCandidateResult({
    status: candidates.length > 0 ? 'candidates_found' : 'no_candidates',
    personalSpaceId,
    parentProjectId,
    childProjectIds,
    query,
    candidates,
    graph
  });
}

export function providerCommonKnowledgePromotion(input) {
  return {
    personal_space_id: input.personalSpaceId,
    parent_project_id: input.parentProjectId,
    item_kind: input.itemKind,
    canonical_item_id: input.canonicalItemId,
    duplicate_item_ids: input.duplicateItemIds,
    reason: input.reason,
    human_confirmation_reason: input.humanConfirmationReason
  };
}

function commonCandidateResult({
  status,
  personalSpaceId,
  parentProjectId,
  childProjectIds,
  query,
  candidates,
  graph
}) {
  return {
    status,
    personal_space_id: personalSpaceId,
    parent_project_id: parentProjectId,
    child_project_ids: childProjectIds,
    query,
    candidates,
    graph_truncated: graph.truncated === true,
    policy: commonKnowledgeCandidatePolicy()
  };
}

function clusterCommonKnowledgeItems(
  items,
  minChildProjects,
  similarityThreshold,
  parentProjectId,
  query
) {
  const groups = [];
  for (const item of items) {
    const matching = groups
      .map((group) => ({
        group,
        similarity: Math.max(
          ...group.items.map((member) => commonKnowledgeSimilarity(item, member))
        )
      }))
      .filter(({ group, similarity }) =>
        group.itemKind === item.item_kind
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
      projectIds: new Set([item.defined_project_id]),
      items: [item]
    });
  }

  return groups
    .filter(({ projectIds }) => projectIds.size >= minChildProjects)
    .map((group) => {
      const orderedItems = [...group.items].sort((left, right) =>
        left.defined_project_id.localeCompare(right.defined_project_id)
      );
      const pairScores = [];
      for (let left = 0; left < orderedItems.length; left += 1) {
        for (let right = left + 1; right < orderedItems.length; right += 1) {
          pairScores.push(commonKnowledgeSimilarity(
            orderedItems[left],
            orderedItems[right]
          ));
        }
      }
      const averageSimilarity = pairScores.length === 0
        ? 1
        : pairScores.reduce((sum, score) => sum + score, 0) / pairScores.length;
      const itemIds = orderedItems.map(({ id }) => id).sort();
      return {
        candidate_id: `common-${createHash('sha256')
          .update(itemIds.join('\n'))
          .digest('hex')
          .slice(0, 20)}`,
        parent_project_id: parentProjectId,
        child_project_ids: [...group.projectIds].sort(),
        item_kind: group.itemKind,
        query,
        similarity_score: Number(averageSimilarity.toFixed(4)),
        similarity_basis: 'lexical_overlap_across_direct_child_projects',
        items: orderedItems,
        requires_human_confirmation: true,
        promotion_performed: false
      };
    })
    .sort((left, right) =>
      right.child_project_ids.length - left.child_project_ids.length
      || right.similarity_score - left.similarity_score
      || left.candidate_id.localeCompare(right.candidate_id)
    );
}

function commonKnowledgeCandidatePolicy() {
  return {
    read_only: true,
    direct_part_of_children_only: true,
    active_human_authorized_relations_only: true,
    personal_preferences_excluded: true,
    inherited_knowledge_excluded: true,
    personal_global_excluded: true,
    automatic_promotion: false,
    human_confirmation_required: true,
    similarity_is_inferred_not_authoritative: true
  };
}
