import { graphNodeIdentity } from './identity.js';

const COLORS = ['#537966', '#867550', '#65758a', '#8a655f', '#6f6a88', '#598080', '#8a765f'];
const MIN_SCALE = 0.18;
const MAX_SCALE = 5;
const MAX_FIT_SCALE = 1.5;

export function renderKnowledgeGraph(svg, graph, options = {}) {
  const d3 = globalThis.d3;
  if (!d3) throw new Error('D3 graph runtime is unavailable');

  const callbacks = typeof options === 'function'
    ? { onNodeSelect: options }
    : options;
  const width = Math.max(svg.clientWidth || 0, 760);
  const height = Math.max(svg.clientHeight || 0, 520);
  const nodes = graph.nodes.map((node) => ({ ...node }));
  const nodeIds = new Set(nodes.map(({ id }) => id));
  const links = graph.edges
    .map((edge, index) => normalizeEdge(edge, index))
    .filter(({ sourceId, targetId }) => nodeIds.has(sourceId) && nodeIds.has(targetId));

  const root = d3.select(svg);
  root.selectAll('*').remove();
  root
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const markerId = `graph-arrow-${Math.random().toString(36).slice(2)}`;
  const defs = root.append('defs');
  defs.append('marker')
    .attr('id', markerId)
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 28)
    .attr('refY', 0)
    .attr('markerWidth', 5)
    .attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('class', 'graph-arrow');

  const viewport = root.append('g').attr('class', 'graph-viewport');
  const edgeLayer = viewport.append('g').attr('class', 'graph-edges');
  const labelLayer = viewport.append('g').attr('class', 'graph-edge-labels');
  const nodeLayer = viewport.append('g').attr('class', 'graph-nodes');

  const edgeLines = edgeLayer.selectAll('line.graph-edge')
    .data(links, ({ id }) => id)
    .join('line')
    .attr('class', (edge) => [
      'graph-edge',
      edge.invalid_at ? 'historical' : null,
      pendingHumanChange(edge) ? 'human-change-pending' : null,
      edge.human_change_status === 'viewed' ? 'human-change-viewed' : null
    ].filter(Boolean).join(' '))
    .attr('marker-end', `url(#${markerId})`);

  const edgeHits = edgeLayer.selectAll('line.graph-edge-hit')
    .data(links, ({ id }) => id)
    .join('line')
    .attr('class', 'graph-edge-hit')
    .attr('role', 'button')
    .attr('tabindex', 0)
    .attr('aria-label', (edge) => `${edge.type}: ${edge.fact || '关系'}`);

  edgeHits.append('title').text((edge) => edge.fact || edge.type);

  const edgeLabels = links.length <= 90
    ? labelLayer.selectAll('text')
      .data(links, ({ id }) => id)
      .join('text')
      .attr('class', 'graph-edge-label')
      .text((edge) => edge.type)
    : labelLayer.selectAll('text');

  const nodeGroups = nodeLayer.selectAll('g.graph-node')
    .data(nodes, ({ id }) => id)
    .join('g')
    .attr('class', (node) => [
      'graph-node',
      isProjectNode(node) ? 'project-node' : null,
      pendingHumanChange(node) ? 'human-change-pending' : null,
      node.human_change_status === 'viewed' ? 'human-change-viewed' : null
    ].filter(Boolean).join(' '))
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', (node) => `${node.name}，ID ${graphNodeIdentity(node)}`);

  nodeGroups.filter((node) => !isProjectNode(node)).append('circle')
    .attr('class', 'graph-node-shape')
    .attr('r', (node) => 10 + Math.min(7, degree(node.id, links)))
    .attr('fill', (node) => colorFor(node.type));
  nodeGroups.filter(isProjectNode).append('circle')
    .attr('class', 'graph-project-ring')
    .attr('r', 24);
  nodeGroups.filter(isProjectNode).append('circle')
    .attr('class', 'graph-node-shape')
    .attr('r', 19);
  nodeGroups.filter(isProjectNode).append('path')
    .attr('class', 'graph-project-icon')
    .attr('d', 'M-9,-7H-3L0,-4H9V7H-9Z');
  nodeGroups.filter(pendingHumanChange).append('circle')
    .attr('class', 'graph-node-human-marker')
    .attr('cx', (node) => isProjectNode(node) ? 20 : 12)
    .attr('cy', (node) => isProjectNode(node) ? -20 : -12)
    .attr('r', 4);
  nodeGroups.append('text')
    .attr('class', 'graph-node-label')
    .attr('y', (node) => isProjectNode(node)
      ? 39
      : 26 + Math.min(7, degree(node.id, links)))
    .text((node) => truncate(node.name, 22));
  nodeGroups.append('text')
    .attr('class', 'graph-node-id')
    .attr('y', (node) => isProjectNode(node)
      ? 51
      : 38 + Math.min(7, degree(node.id, links)))
    .text((node) => `#${graphNodeIdentity(node)}`);
  const searchBadges = nodeGroups.append('g')
    .attr('class', 'graph-search-badge')
    .attr('transform', (node) => `translate(0,${isProjectNode(node) ? -36 : -28})`);
  searchBadges.append('rect')
    .attr('x', -15)
    .attr('y', -8)
    .attr('width', 30)
    .attr('height', 15)
    .attr('rx', 4);
  searchBadges.append('text')
    .attr('y', 3)
    .text('命中');
  nodeGroups.append('title')
    .text((node) => [
      node.name,
      node.type,
      `ID: ${node.id}`,
      isProjectNode(node) ? '已标记为项目' : null,
      pendingHumanChange(node)
        ? node.human_change_status === 'unseen'
          ? '人工修改后，Agent 尚未查看'
          : 'Agent 已查看，等待完成审核'
        : null
    ].filter(Boolean).join('\n'));

  const zoom = d3.zoom()
    .scaleExtent([MIN_SCALE, MAX_SCALE])
    .on('zoom', (event) => viewport.attr('transform', event.transform));
  root.call(zoom).on('dblclick.zoom', null);

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(({ id }) => id).distance(118).strength(0.42))
    .force('charge', d3.forceManyBody().strength(-390).distanceMax(620))
    .force('collide', d3.forceCollide().radius((node) => isProjectNode(node)
      ? 58
      : 38 + Math.min(10, degree(node.id, links))))
    .force('project-focus', d3.forceRadial(
      (node) => isProjectNode(node) ? 70 : 210,
      width / 2,
      height / 2
    ).strength((node) => isProjectNode(node) ? 0.55 : 0.008))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX(width / 2).strength(0.025))
    .force('y', d3.forceY(height / 2).strength(0.025))
    .stop();

  for (let tick = 0; tick < 220; tick += 1) simulation.tick();
  updatePositions();

  const drag = d3.drag()
    .on('start', function startDrag(event, node) {
      event.sourceEvent?.stopPropagation();
      node.dragMoved = false;
      node.fx = node.x;
      node.fy = node.y;
    })
    .on('drag', function dragNode(event, node) {
      node.dragMoved = true;
      node.fx = event.x;
      node.fy = event.y;
      node.x = event.x;
      node.y = event.y;
      d3.select(this).classed('pinned', true);
      updatePositions();
    })
    .on('end', function endDrag(_event, node) {
      if (node.dragMoved) {
        node.fx = node.x;
        node.fy = node.y;
      } else {
        node.fx = null;
        node.fy = null;
        d3.select(this).classed('pinned', false);
      }
      delete node.dragMoved;
    });
  nodeGroups.call(drag);

  nodeGroups
    .on('click', (event, node) => {
      event.stopPropagation();
      selectNode(node);
    })
    .on('keydown', (event, node) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectNode(node);
    })
    .on('dblclick', (event, node) => {
      event.stopPropagation();
      node.fx = null;
      node.fy = null;
      d3.select(event.currentTarget).classed('pinned', false);
      simulation.alpha(0.35).restart();
      window.setTimeout(() => simulation.stop(), 700);
    });

  edgeHits
    .on('click', (event, edge) => {
      event.stopPropagation();
      selectEdge(edge);
    })
    .on('keydown', (event, edge) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectEdge(edge);
    });

  root.on('click.selection', (event) => {
    if (event.target === svg) clearSelection();
  });

  fitToNodes(nodes, 0);

  return {
    zoomIn: () => zoomBy(1.32),
    zoomOut: () => zoomBy(0.76),
    fit: () => fitToNodes(nodes),
    reset: () => {
      clearSelection();
      root.transition().duration(220).call(zoom.transform, d3.zoomIdentity);
    },
    selectItem(itemKind, id) {
      if (itemKind === 'entity') {
        const node = nodes.find((candidate) => candidate.id === id);
        if (!node) return false;
        highlightNode(node);
        fitToNodes([node]);
        return true;
      }
      const edge = links.find((candidate) => candidate.id === id);
      if (!edge) return false;
      highlightEdge(edge);
      fitToNodes([edge.source, edge.target]);
      return true;
    },
    focusByNames(names, { projectOnly = false, searchMatch = false } = {}) {
      const matches = nodes.filter((node) =>
        names.has(node.name) && (!projectOnly || isProjectNode(node))
      );
      if (!matches.length) {
        if (searchMatch) {
          applyHighlight({
            nodeIds: new Set(),
            edgeIds: new Set(),
            selectedNodeId: null,
            selectedEdgeId: null,
            searchMatch
          });
        } else {
          clearSelection();
        }
        return 0;
      }
      const ids = new Set(matches.map(({ id }) => id));
      const edgeIds = new Set(links
        .filter(({ sourceId, targetId }) => ids.has(sourceId) && ids.has(targetId))
        .map(({ id }) => id));
      applyHighlight({
        nodeIds: ids,
        edgeIds,
        selectedNodeId: null,
        selectedEdgeId: null,
        searchMatch
      });
      fitToNodes(matches);
      return matches.length;
    },
    clearSelection,
    destroy() {
      simulation.stop();
      root.on('.zoom', null).on('.selection', null);
      root.selectAll('*').remove();
    }
  };

  function updatePositions() {
    edgeLines
      .attr('x1', (edge) => edge.source.x)
      .attr('y1', (edge) => edge.source.y)
      .attr('x2', (edge) => edge.target.x)
      .attr('y2', (edge) => edge.target.y);
    edgeHits
      .attr('x1', (edge) => edge.source.x)
      .attr('y1', (edge) => edge.source.y)
      .attr('x2', (edge) => edge.target.x)
      .attr('y2', (edge) => edge.target.y);
    edgeLabels
      .attr('x', (edge) => (edge.source.x + edge.target.x) / 2)
      .attr('y', (edge) => (edge.source.y + edge.target.y) / 2 - 5);
    nodeGroups.attr('transform', (node) => `translate(${node.x},${node.y})`);
  }

  function selectNode(node) {
    highlightNode(node);
    callbacks.onNodeSelect?.(node);
  }

  function highlightNode(node) {
    const nodeIds = new Set([node.id]);
    const edgeIds = new Set();
    for (const edge of links) {
      if (edge.sourceId !== node.id && edge.targetId !== node.id) continue;
      edgeIds.add(edge.id);
      nodeIds.add(edge.sourceId);
      nodeIds.add(edge.targetId);
    }
    applyHighlight({ nodeIds, edgeIds, selectedNodeId: node.id, selectedEdgeId: null });
  }

  function selectEdge(edge) {
    highlightEdge(edge);
    callbacks.onEdgeSelect?.(edge);
  }

  function highlightEdge(edge) {
    applyHighlight({
      nodeIds: new Set([edge.sourceId, edge.targetId]),
      edgeIds: new Set([edge.id]),
      selectedNodeId: null,
      selectedEdgeId: edge.id
    });
  }

  function applyHighlight({
    nodeIds,
    edgeIds,
    selectedNodeId,
    selectedEdgeId,
    searchMatch = false
  }) {
    nodeGroups
      .classed('selected', ({ id }) => id === selectedNodeId)
      .classed('related', ({ id }) => nodeIds.has(id) && id !== selectedNodeId)
      .classed('dimmed', ({ id }) => !nodeIds.has(id))
      .classed('search-match', ({ id }) => searchMatch && nodeIds.has(id));
    edgeLines
      .classed('selected', ({ id }) => id === selectedEdgeId)
      .classed('related', ({ id }) => edgeIds.has(id))
      .classed('dimmed', ({ id }) => edgeIds.size > 0 ? !edgeIds.has(id) : true)
      .classed('search-match', ({ id }) => searchMatch && edgeIds.has(id));
    edgeLabels
      .classed('selected', ({ id }) => id === selectedEdgeId)
      .classed('related', ({ id }) => edgeIds.has(id))
      .classed('dimmed', ({ id }) => edgeIds.size > 0 ? !edgeIds.has(id) : true)
      .classed('search-match', ({ id }) => searchMatch && edgeIds.has(id));
  }

  function clearSelection() {
    nodeGroups.classed('selected related dimmed search-match', false);
    edgeLines.classed('selected related dimmed search-match', false);
    edgeLabels.classed('selected related dimmed search-match', false);
  }

  function zoomBy(factor) {
    root.transition().duration(180).call(zoom.scaleBy, factor);
  }

  function fitToNodes(items, duration = 220) {
    if (!items.length) return;
    const xs = items.map(({ x }) => x);
    const ys = items.map(({ y }) => y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const boundsWidth = Math.max(maxX - minX, 90);
    const boundsHeight = Math.max(maxY - minY, 90);
    const scale = Math.max(MIN_SCALE, Math.min(
      MAX_FIT_SCALE,
      0.82 / Math.max(boundsWidth / width, boundsHeight / height)
    ));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const transform = d3.zoomIdentity
      .translate(width / 2 - scale * centerX, height / 2 - scale * centerY)
      .scale(scale);
    const target = duration ? root.transition().duration(duration) : root;
    target.call(zoom.transform, transform);
  }
}

function normalizeEdge(edge, index) {
  const sourceId = endpointId(edge.source);
  const targetId = endpointId(edge.target);
  return {
    ...edge,
    id: edge.id ?? `edge-${index}-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    source: sourceId,
    target: targetId
  };
}

function endpointId(endpoint) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint;
}

function colorFor(type) {
  return COLORS[Math.floor(seeded(type) * COLORS.length) % COLORS.length];
}

export function isProjectNode(node) {
  return node?.type === 'PersonalProject' || node?.type === 'RelatedPersonalProject';
}

function pendingHumanChange(item) {
  return item?.human_change_status === 'unseen'
    || item?.human_change_status === 'viewed';
}

function degree(id, edges) {
  return edges.reduce((count, edge) =>
    count + Number(edge.sourceId === id || edge.targetId === id), 0);
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function seeded(value = '') {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 10000) / 10000;
}
