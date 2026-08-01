import { createHash } from 'node:crypto';

import { onlineSourceUri } from './source-uri.js';

export async function beginTaskContext(application, {
  sessionId,
  projectPath,
  taskPrompt = null
}) {
  const preferences = await application.getCollaborationPreferences({
    projectPath,
    taskPrompt,
    agentInvocation: true,
    agentToolName: 'begin_task_context'
  });
  const task = application.taskContextRegistry.begin({
    sessionId,
    personalProjectId: preferences.context.personal_project_id
  });
  return {
    taskContextToken: task.token,
    task_context_token: task.token,
    checkpoint_required: true,
    previous_checkpoint_missing: task.previousCheckpointMissing,
    ...preferences,
    task_guidance: {
      retrieval: 'Inspect task_knowledge_recall before asking for a stable project fact or method again. On a miss, use search_current_project_knowledge with focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query.',
      checkpoint: 'Before finishing, call checkpoint_task_knowledge with capture_candidates or retain_nothing.'
    }
  };
}

export async function checkpointTaskKnowledge(application, {
  taskContextToken,
  disposition,
  reason,
  capture = null
}) {
  if (!['capture_candidates', 'retain_nothing'].includes(disposition)) {
    throw new TypeError('Unknown task knowledge checkpoint disposition');
  }
  const task = application.taskContextRegistry.context(taskContextToken);

  let captureResult = null;
  if (disposition === 'capture_candidates') {
    if (!capture) {
      throw new TypeError('capture_candidates requires a bounded capture payload');
    }
    captureResult = await application.captureSessionKnowledge({
      targetKind: 'personal',
      spaceId: application.config.personal.spaceId,
      personalProjectId: task.personalProjectId,
      sessionId: task.sessionId,
      ...capture
    });
  } else if (capture) {
    throw new TypeError('retain_nothing cannot include a capture payload');
  }

  application.taskContextRegistry.checkpoint(taskContextToken, {
    disposition,
    reason,
    captureStatus: captureResult?.status ?? null
  });
  return {
    status: 'checkpointed',
    disposition,
    reason,
    personal_project_id: task.personalProjectId,
    capture: captureResult
  };
}

export async function recordDecisionTrace(application, input) {
  const trace = decisionTraceKnowledge(input);
  return application.captureSessionKnowledge({
    targetKind: 'personal',
    spaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    name: `Decision · ${input.title}`,
    sourceKind: input.sourceKind,
    sourceDescription: input.sourceDescription,
    sourceUri: input.sourceUri ?? null,
    sourceApplication: input.sourceApplication ?? null,
    sourceTurnId: input.sourceTurnId ?? null,
    referenceTime: input.referenceTime,
    summary: `${input.question}\nSelected: ${input.selectedOption.label}`,
    sensitivity: input.sensitivity ?? 'normal',
    ...trace
  });
}

export async function searchCurrentProjectKnowledge(
  application,
  resolution,
  {
    queries,
    limitPerQuery = 12,
    includeHistorical = false,
    includePending = false
  }
) {
  const projectResolution = agentProjectResolution(resolution);
  if (!resolution.personalProjectId) {
    return {
      status: 'project_unresolved',
      personal_space_id: application.config.personal.spaceId,
      personal_project_id: null,
      project_resolution: projectResolution,
      results: [],
      required_action: resolution.status === 'ambiguous'
        ? 'Run from the exact project directory or explicitly choose one project; Fuli will not guess among workspace children.'
        : 'Register this repository or directory as one local personal project before project-scoped search.'
    };
  }

  const results = await Promise.all(queries.map((query) =>
    application.searchKnowledge({
      personalSpaceId: application.config.personal.spaceId,
      personalProjectId: resolution.personalProjectId,
      query,
      limit: limitPerQuery,
      includeHistorical,
      includePending,
      agentInvocation: true,
      agentToolName: 'search_current_project_knowledge'
    })
  ));
  return {
    status: 'searched',
    personal_space_id: application.config.personal.spaceId,
    personal_project_id: resolution.personalProjectId,
    project_resolution: projectResolution,
    scope_policy: {
      local_project_first: true,
      inherited_relation_types: ['PART_OF', 'USES_KNOWLEDGE_FROM'],
      max_inheritance_hops: 2,
      local_same_key_overrides_parent: true,
      unrelated_relations_expand_scope: false
    },
    results
  };
}

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
      .filter(({ type, source, target }) =>
        type === 'PART_OF'
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
  ]);
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

export async function recordKnowledgeFeedback(application, {
  personalSpaceId,
  taskId,
  sessionId = null,
  toolName = null,
  items
}) {
  return application.personal.recordKnowledgeFeedback({
    personal_space_id: personalSpaceId,
    task_id: taskId,
    session_id: sessionId,
    tool_name: toolName,
    items: items.map((item) => ({
      item_id: item.itemId,
      item_kind: item.itemKind,
      feedback_kind: item.feedbackKind,
      reason: item.reason,
      evidence_summary: item.evidenceSummary,
      reported_by_kind: item.reportedByKind,
      source_uri: onlineSourceUri(item.sourceUri)
    }))
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

export function agentProjectResolution(resolution) {
  const result = {
    status: resolution.status,
    basis: resolution.basis,
    personal_project_id: resolution.personalProjectId
  };
  if (resolution.candidateCount !== undefined) {
    result.candidate_count = resolution.candidateCount;
  }
  return result;
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

function commonKnowledgeItem(item, itemKind, projectId) {
  return {
    ...item,
    item_kind: itemKind,
    defined_project_id: projectId
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

function commonKnowledgeSimilarity(left, right) {
  if (left.key && right.key && left.key === right.key) return 1;
  const leftTokens = commonKnowledgeTokens(left);
  const rightTokens = commonKnowledgeTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function commonKnowledgeTokens(item) {
  const text = [
    item.name,
    item.summary,
    item.fact,
    item.type
  ].filter(Boolean).join(' ').toLowerCase();
  const tokens = new Set(
    text.match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g) ?? []
  );
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (sequence.length === 1) tokens.add(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(sequence.slice(index, index + 2));
    }
  }
  return tokens;
}

function commonKnowledgeCandidatePolicy() {
  return {
    read_only: true,
    direct_part_of_children_only: true,
    inherited_knowledge_excluded: true,
    personal_global_excluded: true,
    automatic_promotion: false,
    human_confirmation_required: true,
    similarity_is_inferred_not_authoritative: true
  };
}

function decisionTraceKnowledge(input) {
  const decisionKey = `decision:${input.decisionKey}`;
  const selectedKey = `${decisionKey}:option:${input.selectedOption.key}`;
  const rationaleKey = `${decisionKey}:rationale`;
  const rejected = input.rejectedOptions ?? [];
  const validations = input.validationResults ?? [];
  const confirmed = ['user', 'authoritative_source'].includes(
    input.decidedBy.kind
  );
  const confirmationStatus = confirmed ? 'confirmed' : 'pending';
  const epistemicStatus = confirmed ? 'confirmed' : 'observed';
  const confirmationBasis = {
    existenceReason: input.sourceDescription,
    quadrantReason: input.reason,
    proposedBy: input.decidedBy,
    confirmedBy: confirmed ? input.decidedBy : null,
    confirmedAt: confirmed ? input.referenceTime : null,
    agentPolicyVersion: null
  };
  const epistemic = {
    originQuadrant: 'known_known',
    currentQuadrant: 'known_known',
    epistemicStatus,
    confirmationStatus,
    confirmationBasis,
    reasoningSummary: input.reason,
    inheritanceMode: 'local_only',
    inheritedProjectIds: []
  };
  const entities = [
    {
      key: decisionKey,
      name: input.title,
      type: 'Decision',
      summary: `${input.question}\nSelected: ${input.selectedOption.label}`,
      attributes: {
        decisionKey: input.decisionKey,
        selectedOptionKey: input.selectedOption.key,
        decidedByKind: input.decidedBy.kind
      },
      ...epistemic
    },
    {
      key: selectedKey,
      name: input.selectedOption.label,
      type: 'DecisionOption',
      summary: input.selectedOption.summary ?? '',
      attributes: { disposition: 'selected' },
      ...epistemic
    },
    ...rejected.map((option) => ({
      key: `${decisionKey}:option:${option.key}`,
      name: option.label,
      type: 'DecisionOption',
      summary: option.summary ?? '',
      attributes: { disposition: 'rejected' },
      ...epistemic
    })),
    {
      key: rationaleKey,
      name: `${input.title} · rationale`,
      type: 'DecisionRationale',
      summary: input.reason,
      attributes: {},
      ...epistemic
    },
    ...validations.map((validation) => ({
      key: `${decisionKey}:validation:${validation.key}`,
      name: `${input.title} · ${validation.key}`,
      type: 'ValidationResult',
      summary: validation.summary,
      attributes: { outcome: validation.outcome },
      ...epistemic
    }))
  ];
  const relationship = (key, target, type, fact) => ({
    key,
    source: decisionKey,
    target,
    type,
    fact,
    confidence: confirmed ? 1 : 0.7,
    attributes: {},
    ...epistemic
  });
  return {
    entities,
    relationships: [
      relationship(
        `${decisionKey}:selected`,
        selectedKey,
        'SELECTED_OPTION',
        `${input.title} selected ${input.selectedOption.label}.`
      ),
      ...rejected.map((option) => relationship(
        `${decisionKey}:rejected:${option.key}`,
        `${decisionKey}:option:${option.key}`,
        'REJECTED_OPTION',
        `${input.title} did not select ${option.label}.`
      )),
      relationship(
        `${decisionKey}:motivated-by`,
        rationaleKey,
        'MOTIVATED_BY',
        input.reason
      ),
      ...validations.map((validation) => relationship(
        `${decisionKey}:validated-by:${validation.key}`,
        `${decisionKey}:validation:${validation.key}`,
        'VALIDATED_BY',
        `${validation.outcome}: ${validation.summary}`
      ))
    ]
  };
}
