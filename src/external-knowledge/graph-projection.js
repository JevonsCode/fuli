export function mergeExternalKnowledgeProjection(
  externalKnowledge,
  graph,
  personalSpaceId,
  personalProjectId
) {
  const projection = externalKnowledge?.projectGraphProjection?.({
    personalSpaceId,
    personalProjectId,
    graph
  }) ?? { nodes: [], edges: [] };
  return {
    ...graph,
    nodes: [...graph.nodes, ...projection.nodes],
    edges: [...graph.edges, ...projection.edges]
  };
}
