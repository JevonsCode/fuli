import * as d3 from 'd3'

import { t } from '@/i18n'
import { graphNodeIdentity } from '@/lib/identity'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'
import { localizeRelationTokens, relationVisual } from './relation-visuals'

export interface GraphController {
  zoomIn(): void
  zoomOut(): void
  fit(): void
  reset(): void
  clearSelection(): void
  selectItem(itemKind: 'entity' | 'relationship', id: string): boolean
  focusByNames(
    names: Set<string>,
    options?: { projectOnly?: boolean; searchMatch?: boolean },
  ): number
  destroy(): void
}

export interface GraphRenderOptions {
  onNodeSelect?(node: KnowledgeNode): void
  onEdgeSelect?(edge: KnowledgeEdge): void
}

interface GraphNodeDatum extends KnowledgeNode, d3.SimulationNodeDatum {
  dragMoved?: boolean
}

interface GraphEdgeDatum extends d3.SimulationLinkDatum<GraphNodeDatum> {
  id: string
  sourceId: string
  targetId: string
  source: string | GraphNodeDatum
  target: string | GraphNodeDatum
  type: string
  fact?: string
  invalid_at?: string | null
  human_change_status?: KnowledgeEdge['human_change_status']
  raw: KnowledgeEdge
}

const COLORS = ['#537966', '#867550', '#65758a', '#8a655f', '#6f6a88', '#598080', '#8a765f']
const MIN_SCALE = 0.18
const MAX_SCALE = 5
const MAX_FIT_SCALE = 1.5

export function renderKnowledgeGraph(
  svg: SVGSVGElement,
  graph: KnowledgeGraph,
  options: GraphRenderOptions | GraphRenderOptions['onNodeSelect'] = {},
): GraphController {
  const callbacks = typeof options === 'function'
    ? { onNodeSelect: options }
    : options
  const width = Math.max(svg.clientWidth || 0, 760)
  const height = Math.max(svg.clientHeight || 0, 520)
  const nodes: GraphNodeDatum[] = graph.nodes.map((node) => ({ ...node }))
  const nodeIds = new Set(nodes.map(({ id }) => id))
  const links = graph.edges
    .map(normalizeEdge)
    .filter(({ sourceId, targetId }) => nodeIds.has(sourceId) && nodeIds.has(targetId))

  const root = d3.select<SVGSVGElement, unknown>(svg)
  root.selectAll('*').remove()
  root
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet')

  const markerId = `graph-arrow-${Math.random().toString(36).slice(2)}`
  const defs = root.append('defs')
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
    .attr('class', 'graph-arrow')

  const viewport = root.append('g').attr('class', 'graph-viewport')
  const edgeLayer = viewport.append('g').attr('class', 'graph-edges')
  const labelLayer = viewport.append('g').attr('class', 'graph-edge-labels')
  const nodeLayer = viewport.append('g').attr('class', 'graph-nodes')

  const edgeLines = edgeLayer.selectAll<SVGLineElement, GraphEdgeDatum>('line.graph-edge')
    .data(links)
    .join('line')
    .attr('class', (edge) => [
      'graph-edge',
      edge.invalid_at ? 'historical' : null,
      pendingHumanChange(edge) ? 'human-change-pending' : null,
      edge.human_change_status === 'viewed' ? 'human-change-viewed' : null,
    ].filter(Boolean).join(' '))
    .attr('marker-end', `url(#${markerId})`)

  const edgeHits = edgeLayer.selectAll<SVGLineElement, GraphEdgeDatum>('line.graph-edge-hit')
    .data(links)
    .join('line')
    .attr('class', 'graph-edge-hit')
    .attr('role', 'button')
    .attr('tabindex', 0)
    .attr('aria-label', (edge) => {
      const visual = relationVisual(edge.type)
      return `${visual.label}：${localizeRelationTokens(edge.fact || visual.description)}`
    })

  edgeHits.append('title').text((edge) => {
    const visual = relationVisual(edge.type)
    return `${visual.label}：${localizeRelationTokens(edge.fact || visual.description)}`
  })

  const edgeLabels = links.length <= 90
    ? labelLayer.selectAll<SVGGElement, GraphEdgeDatum>('g.graph-edge-label')
      .data(links)
      .join('g')
      .attr('class', 'graph-edge-label')
      .attr('data-relation-type', (edge) => edge.type)
    : labelLayer.selectAll<SVGGElement, GraphEdgeDatum>('g.graph-edge-label')

  edgeLabels.append('rect')
    .attr('class', 'graph-edge-label-bg')
    .attr('x', (edge) => -edgeLabelWidth(edge) / 2)
    .attr('y', -10)
    .attr('width', edgeLabelWidth)
    .attr('height', 20)
    .attr('rx', 10)
  edgeLabels.append('path')
    .attr('class', 'graph-edge-label-icon')
    .attr('d', (edge) => relationVisual(edge.type).iconPath)
    .attr(
      'transform',
      (edge) => `translate(${-edgeLabelWidth(edge) / 2 + 6},-6) scale(.5)`,
    )
  edgeLabels.append('text')
    .attr('class', 'graph-edge-label-text')
    .attr('x', (edge) => -edgeLabelWidth(edge) / 2 + 22)
    .attr('y', 3.5)
    .text((edge) => relationVisual(edge.type).label)
  edgeLabels.append('title')
    .text((edge) => {
      const visual = relationVisual(edge.type)
      return `${visual.label}：${visual.description}`
    })

  const nodeGroups = nodeLayer.selectAll<SVGGElement, GraphNodeDatum>('g.graph-node')
    .data(nodes)
    .join('g')
    .attr('class', (node) => [
      'graph-node',
      isProjectNode(node) ? 'project-node' : null,
      pendingHumanChange(node) ? 'human-change-pending' : null,
      node.human_change_status === 'viewed' ? 'human-change-viewed' : null,
    ].filter(Boolean).join(' '))
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr(
      'aria-label',
      (node) => `${localizeRelationTokens(node.name)}，ID ${graphNodeIdentity(node)}`,
    )

  nodeGroups.filter((node) => !isProjectNode(node)).append('circle')
    .attr('class', 'graph-node-shape')
    .attr('r', (node) => 10 + Math.min(7, degree(node.id, links)))
    .attr('fill', (node) => colorFor(node.type))
  nodeGroups.filter(isProjectNode).append('circle')
    .attr('class', 'graph-project-ring')
    .attr('r', 24)
  nodeGroups.filter(isProjectNode).append('circle')
    .attr('class', 'graph-node-shape')
    .attr('r', 19)
  nodeGroups.filter(isProjectNode).append('path')
    .attr('class', 'graph-project-icon')
    .attr('d', 'M-9,-7H-3L0,-4H9V7H-9Z')
  nodeGroups.filter(pendingHumanChange).append('circle')
    .attr('class', 'graph-node-human-marker')
    .attr('cx', (node) => isProjectNode(node) ? 20 : 12)
    .attr('cy', (node) => isProjectNode(node) ? -20 : -12)
    .attr('r', 4)
  nodeGroups.append('text')
    .attr('class', 'graph-node-label')
    .attr('y', (node) => isProjectNode(node)
      ? 39
      : 26 + Math.min(7, degree(node.id, links)))
    .text((node) => truncate(localizeRelationTokens(node.name), 22))
  nodeGroups.append('text')
    .attr('class', 'graph-node-id')
    .attr('y', (node) => isProjectNode(node)
      ? 51
      : 38 + Math.min(7, degree(node.id, links)))
    .text((node) => `#${graphNodeIdentity(node)}`)
  const searchBadges = nodeGroups.append('g')
    .attr('class', 'graph-search-badge')
    .attr('transform', (node) => `translate(0,${isProjectNode(node) ? -36 : -28})`)
  searchBadges.append('rect')
    .attr('x', -15)
    .attr('y', -8)
    .attr('width', 30)
    .attr('height', 15)
    .attr('rx', 4)
  searchBadges.append('text')
    .attr('y', 3)
    .text(t('knowledge.domain.graph.hit'))
  nodeGroups.append('title')
    .text((node) => [
      localizeRelationTokens(node.name),
      node.type,
      `ID: ${node.id}`,
      isProjectNode(node) ? t('knowledge.domain.graph.projectMarked') : null,
      pendingHumanChange(node)
        ? node.human_change_status === 'unseen'
          ? t('knowledge.domain.graph.humanUnseen')
          : t('knowledge.domain.graph.humanViewed')
        : null,
    ].filter(Boolean).join('\n'))

  const zoom = d3.zoom<SVGSVGElement, unknown>()
    .scaleExtent([MIN_SCALE, MAX_SCALE])
    .on('zoom', (event) => viewport.attr('transform', event.transform.toString()))
  root.call(zoom).on('dblclick.zoom', null)

  const simulation = d3.forceSimulation<GraphNodeDatum>(nodes)
    .force(
      'link',
      d3.forceLink<GraphNodeDatum, GraphEdgeDatum>(links)
        .id(({ id }) => id)
        .distance(118)
        .strength(0.42),
    )
    .force('charge', d3.forceManyBody<GraphNodeDatum>().strength(-390).distanceMax(620))
    .force(
      'collide',
      d3.forceCollide<GraphNodeDatum>().radius(
        (node) => isProjectNode(node)
          ? 58
          : 38 + Math.min(10, degree(node.id, links)),
      ),
    )
    .force(
      'project-focus',
      d3.forceRadial<GraphNodeDatum>(
        (node) => isProjectNode(node) ? 70 : 210,
        width / 2,
        height / 2,
      ).strength((node) => isProjectNode(node) ? 0.55 : 0.008),
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('x', d3.forceX<GraphNodeDatum>(width / 2).strength(0.025))
    .force('y', d3.forceY<GraphNodeDatum>(height / 2).strength(0.025))
    .stop()

  for (let tick = 0; tick < 220; tick += 1) simulation.tick()
  updatePositions()

  const drag = d3.drag<SVGGElement, GraphNodeDatum>()
    .on('start', (event, node) => {
      event.sourceEvent?.stopPropagation()
      node.dragMoved = false
      node.fx = node.x
      node.fy = node.y
    })
    .on('drag', function dragNode(event, node) {
      node.dragMoved = true
      node.fx = event.x
      node.fy = event.y
      node.x = event.x
      node.y = event.y
      d3.select(this).classed('pinned', true)
      updatePositions()
    })
    .on('end', function endDrag(_event, node) {
      if (node.dragMoved) {
        node.fx = node.x
        node.fy = node.y
      } else {
        node.fx = null
        node.fy = null
        d3.select(this).classed('pinned', false)
      }
      delete node.dragMoved
    })
  nodeGroups.call(drag)

  nodeGroups
    .on('click', (event, node) => {
      event.stopPropagation()
      selectNode(node)
    })
    .on('keydown', (event, node) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      selectNode(node)
    })
    .on('dblclick', (event, node) => {
      event.stopPropagation()
      node.fx = null
      node.fy = null
      d3.select(event.currentTarget).classed('pinned', false)
      simulation.alpha(0.35).restart()
      window.setTimeout(() => simulation.stop(), 700)
    })

  edgeHits
    .on('click', (event, edge) => {
      event.stopPropagation()
      selectEdge(edge)
    })
    .on('keydown', (event, edge) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      selectEdge(edge)
    })

  root.on('click.selection', (event) => {
    if (event.target === svg) clearSelection()
  })

  fitToNodes(nodes, 0)

  return {
    zoomIn: () => zoomBy(1.32),
    zoomOut: () => zoomBy(0.76),
    fit: () => fitToNodes(nodes),
    reset: () => {
      clearSelection()
      root.transition().duration(220).call(zoom.transform, d3.zoomIdentity)
    },
    selectItem(itemKind, id) {
      if (itemKind === 'entity') {
        const node = nodes.find((candidate) => candidate.id === id)
        if (!node) return false
        highlightNode(node)
        fitToNodes([node])
        return true
      }
      const edge = links.find((candidate) => candidate.id === id)
      if (!edge) return false
      highlightEdge(edge)
      fitToNodes([linkedNode(edge.source), linkedNode(edge.target)])
      return true
    },
    focusByNames(names, { projectOnly = false, searchMatch = false } = {}) {
      const matches = nodes.filter(
        (node) => names.has(node.name) && (!projectOnly || isProjectNode(node)),
      )
      if (!matches.length) {
        if (searchMatch) {
          applyHighlight({
            nodeIds: new Set(),
            edgeIds: new Set(),
            selectedNodeId: null,
            selectedEdgeId: null,
            searchMatch,
          })
        } else {
          clearSelection()
        }
        return 0
      }
      const ids = new Set(matches.map(({ id }) => id))
      const edgeIds = new Set(
        links
          .filter(({ sourceId, targetId }) => ids.has(sourceId) && ids.has(targetId))
          .map(({ id }) => id),
      )
      applyHighlight({
        nodeIds: ids,
        edgeIds,
        selectedNodeId: null,
        selectedEdgeId: null,
        searchMatch,
      })
      fitToNodes(matches)
      return matches.length
    },
    clearSelection,
    destroy() {
      simulation.stop()
      root.on('.zoom', null).on('.selection', null)
      root.selectAll('*').remove()
    },
  }

  function updatePositions() {
    edgeLines
      .attr('x1', (edge) => coordinate(edge.source, 'x'))
      .attr('y1', (edge) => coordinate(edge.source, 'y'))
      .attr('x2', (edge) => coordinate(edge.target, 'x'))
      .attr('y2', (edge) => coordinate(edge.target, 'y'))
    edgeHits
      .attr('x1', (edge) => coordinate(edge.source, 'x'))
      .attr('y1', (edge) => coordinate(edge.source, 'y'))
      .attr('x2', (edge) => coordinate(edge.target, 'x'))
      .attr('y2', (edge) => coordinate(edge.target, 'y'))
    edgeLabels
      .attr('transform', (edge) => `translate(${
        (coordinate(edge.source, 'x') + coordinate(edge.target, 'x')) / 2
      },${
        (coordinate(edge.source, 'y') + coordinate(edge.target, 'y')) / 2 - 5
      })`)
    nodeGroups.attr(
      'transform',
      (node) => `translate(${node.x ?? width / 2},${node.y ?? height / 2})`,
    )
  }

  function selectNode(node: GraphNodeDatum) {
    highlightNode(node)
    callbacks.onNodeSelect?.(node)
  }

  function highlightNode(node: GraphNodeDatum) {
    const highlightedNodeIds = new Set([node.id])
    const highlightedEdgeIds = new Set<string>()
    for (const edge of links) {
      if (edge.sourceId !== node.id && edge.targetId !== node.id) continue
      highlightedEdgeIds.add(edge.id)
      highlightedNodeIds.add(edge.sourceId)
      highlightedNodeIds.add(edge.targetId)
    }
    applyHighlight({
      nodeIds: highlightedNodeIds,
      edgeIds: highlightedEdgeIds,
      selectedNodeId: node.id,
      selectedEdgeId: null,
    })
  }

  function selectEdge(edge: GraphEdgeDatum) {
    highlightEdge(edge)
    callbacks.onEdgeSelect?.(edge.raw)
  }

  function highlightEdge(edge: GraphEdgeDatum) {
    applyHighlight({
      nodeIds: new Set([edge.sourceId, edge.targetId]),
      edgeIds: new Set([edge.id]),
      selectedNodeId: null,
      selectedEdgeId: edge.id,
    })
  }

  function applyHighlight({
    nodeIds: highlightedNodeIds,
    edgeIds: highlightedEdgeIds,
    selectedNodeId,
    selectedEdgeId,
    searchMatch = false,
  }: {
    nodeIds: Set<string>
    edgeIds: Set<string>
    selectedNodeId: string | null
    selectedEdgeId: string | null
    searchMatch?: boolean
  }) {
    nodeGroups
      .classed('selected', ({ id }) => id === selectedNodeId)
      .classed('related', ({ id }) => highlightedNodeIds.has(id) && id !== selectedNodeId)
      .classed('dimmed', ({ id }) => !highlightedNodeIds.has(id))
      .classed('search-match', ({ id }) => searchMatch && highlightedNodeIds.has(id))
    edgeLines
      .classed('selected', ({ id }) => id === selectedEdgeId)
      .classed('related', ({ id }) => highlightedEdgeIds.has(id))
      .classed(
        'dimmed',
        ({ id }) => highlightedEdgeIds.size > 0 ? !highlightedEdgeIds.has(id) : true,
      )
      .classed('search-match', ({ id }) => searchMatch && highlightedEdgeIds.has(id))
    edgeLabels
      .classed('selected', ({ id }) => id === selectedEdgeId)
      .classed('related', ({ id }) => highlightedEdgeIds.has(id))
      .classed(
        'dimmed',
        ({ id }) => highlightedEdgeIds.size > 0 ? !highlightedEdgeIds.has(id) : true,
      )
      .classed('search-match', ({ id }) => searchMatch && highlightedEdgeIds.has(id))
  }

  function clearSelection() {
    nodeGroups.classed('selected related dimmed search-match', false)
    edgeLines.classed('selected related dimmed search-match', false)
    edgeLabels.classed('selected related dimmed search-match', false)
  }

  function zoomBy(factor: number) {
    root.transition().duration(180).call(zoom.scaleBy, factor)
  }

  function fitToNodes(items: GraphNodeDatum[], duration = 220) {
    if (!items.length) return
    const xs = items.map(({ x }) => x ?? width / 2)
    const ys = items.map(({ y }) => y ?? height / 2)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const boundsWidth = Math.max(maxX - minX, 90)
    const boundsHeight = Math.max(maxY - minY, 90)
    const scale = Math.max(
      MIN_SCALE,
      Math.min(
        MAX_FIT_SCALE,
        0.82 / Math.max(boundsWidth / width, boundsHeight / height),
      ),
    )
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2
    const transform = d3.zoomIdentity
      .translate(width / 2 - scale * centerX, height / 2 - scale * centerY)
      .scale(scale)
    if (duration) {
      root.transition().duration(duration).call(zoom.transform, transform)
    } else {
      root.call(zoom.transform, transform)
    }
  }
}

function normalizeEdge(edge: KnowledgeEdge, index: number): GraphEdgeDatum {
  const sourceId = endpointId(edge.source)
  const targetId = endpointId(edge.target)
  return {
    id: edge.id || `edge-${index}-${sourceId}-${targetId}`,
    sourceId,
    targetId,
    source: sourceId,
    target: targetId,
    type: edge.type,
    fact: edge.fact,
    invalid_at: edge.invalid_at,
    human_change_status: edge.human_change_status,
    raw: edge,
  }
}

function endpointId(endpoint: string | KnowledgeNode) {
  return typeof endpoint === 'object' && endpoint !== null ? endpoint.id : endpoint
}

function linkedNode(endpoint: string | GraphNodeDatum) {
  if (typeof endpoint === 'object' && endpoint !== null) return endpoint
  throw new Error(`Graph edge endpoint was not linked: ${endpoint}`)
}

function coordinate(endpoint: string | GraphNodeDatum, axis: 'x' | 'y') {
  return linkedNode(endpoint)[axis] ?? 0
}

function colorFor(type: string) {
  return COLORS[Math.floor(seeded(type) * COLORS.length) % COLORS.length]
}

export function isProjectNode(node: KnowledgeNode | null | undefined) {
  return node?.type === 'PersonalProject' || node?.type === 'RelatedPersonalProject'
}

function pendingHumanChange(item: KnowledgeNode | GraphEdgeDatum | null | undefined) {
  return item?.human_change_status === 'unseen'
    || item?.human_change_status === 'viewed'
}

function degree(id: string, edges: GraphEdgeDatum[]) {
  return edges.reduce(
    (count, edge) => count + Number(edge.sourceId === id || edge.targetId === id),
    0,
  )
}

function edgeLabelWidth(edge: GraphEdgeDatum) {
  return Math.max(54, 31 + [...relationVisual(edge.type).label].length * 10)
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function seeded(value = '') {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return ((hash >>> 0) % 10000) / 10000
}
