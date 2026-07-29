import { renderKnowledgeGraph as renderLegacyGraph } from '../../../js/graph-view.js'

import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'

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

export const renderKnowledgeGraph = renderLegacyGraph as (
  svg: SVGSVGElement,
  graph: KnowledgeGraph,
  options?: {
    onNodeSelect?(node: KnowledgeNode): void
    onEdgeSelect?(edge: KnowledgeEdge): void
  },
) => GraphController
