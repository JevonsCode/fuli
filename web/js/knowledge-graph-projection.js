export function currentKnowledgeGraph(graph) {
  if (!graph) return null;
  const nodes = (graph.nodes ?? []).filter((node) => !node.invalid_at);
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const edges = (graph.edges ?? []).filter((edge) =>
    !edge.invalid_at &&
    nodeIds.has(endpointId(edge.source)) &&
    nodeIds.has(endpointId(edge.target))
  );
  return { ...graph, nodes, edges };
}

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}
