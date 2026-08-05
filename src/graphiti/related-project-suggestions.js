const SUGGESTED_RELATION_TYPES = new Set(['RELATED_TO']);

export function relatedProjectSuggestions(graph, currentProjectId) {
  const nodes = new Map(
    (graph?.nodes ?? [])
      .filter((node) => projectId(node))
      .map((node) => [node.id, node])
  );
  const currentNodes = new Set(
    [...nodes.values()]
      .filter((node) => projectId(node) === currentProjectId)
      .map(({ id }) => id)
  );
  const suggestions = [];

  for (const edge of graph?.edges ?? []) {
    if (!SUGGESTED_RELATION_TYPES.has(edge.type)) continue;
    if (relationStatus(edge) !== 'active') continue;
    if (relationAuthority(edge) !== 'human_review') continue;
    const currentIsSource = currentNodes.has(edge.source);
    const currentIsTarget = currentNodes.has(edge.target);
    if (currentIsSource === currentIsTarget) continue;
    const relatedNode = nodes.get(currentIsSource ? edge.target : edge.source);
    const relatedProjectId = projectId(relatedNode);
    if (!relatedProjectId || relatedProjectId === currentProjectId) continue;
    suggestions.push({
      personal_project_id: relatedProjectId,
      project_name: relatedNode.name ?? relatedProjectId,
      relation_id: edge.id,
      relation_type: edge.type,
      relation_status: 'active',
      direction: currentIsSource ? 'outgoing' : 'incoming',
      reason: edge.fact ?? `The current project has a ${edge.type} relation to ${relatedProjectId}.`,
      requires_human_confirmation: true,
      expansion_mode: 'one_time_read_only',
      confirmed_search: {
        tool: 'search_knowledge_graph',
        personal_project_scope: 'bounded',
        context_personal_project_ids: [relatedProjectId]
      }
    });
  }

  return suggestions.sort((left, right) => (
    left.personal_project_id.localeCompare(right.personal_project_id)
    || left.relation_id.localeCompare(right.relation_id)
  ));
}

export function relatedProjectSuggestionsForSearchResults(graph, result) {
  const resultIdsByProject = new Map();
  for (const item of [...(result?.facts ?? []), ...(result?.entities ?? [])]) {
    const projectId = exactProjectId(item);
    if (!projectId) continue;
    const resultIds = resultIdsByProject.get(projectId) ?? [];
    if (typeof item.id === 'string' && item.id && !resultIds.includes(item.id)) {
      resultIds.push(item.id);
    }
    resultIdsByProject.set(projectId, resultIds);
  }

  const suggestions = [];
  for (const [projectId, resultIds] of resultIdsByProject) {
    for (const suggestion of relatedProjectSuggestions(graph, projectId)) {
      suggestions.push({
        ...suggestion,
        triggered_by_project_id: projectId,
        triggered_by_result_ids: resultIds
      });
    }
  }
  return suggestions.sort((left, right) => (
    left.triggered_by_project_id.localeCompare(right.triggered_by_project_id)
    || left.personal_project_id.localeCompare(right.personal_project_id)
    || left.relation_id.localeCompare(right.relation_id)
  ));
}

export function relatedProjectGuidance(suggestions) {
  if (suggestions.length === 0) return null;
  const projectIds = suggestions
    .map(({ personal_project_id: projectId }) => projectId)
    .join(', ');
  return 'Ask whether this task may add a one-time read-only search of exactly: ' +
    `${projectIds}. Do not expand before explicit human confirmation.`;
}

function projectId(node) {
  return node?.attributes?.projectId;
}

function relationStatus(edge) {
  return edge?.attributes?.status ?? edge?.status ?? null;
}

function relationAuthority(edge) {
  return edge?.attributes?.confirmationAuthority
    ?? edge?.attributes?.confirmation_authority
    ?? edge?.confirmation_authority
    ?? null;
}

function exactProjectId(item) {
  if (item?.inherited_from_project_id) return null;
  if (Number(item?.scope_distance ?? 0) !== 0) return null;
  return typeof item?.defined_project_id === 'string' && item.defined_project_id
    ? item.defined_project_id
    : null;
}
