<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { currentLocale, t } from '@/i18n'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { loadProjectLeads } from '@/features/projects/project-leads'
import { useConsoleStore } from '@/stores/console'
import { isProjectNode, renderKnowledgeGraph, type GraphController, type ProjectDragEvent } from './graph-runtime'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'

const props = defineProps<{
  graph: KnowledgeGraph
  projectVisibility?: 'formal' | 'provided'
  /** 调整层级: dragging a project reports where it would be dropped. */
  organizeProjects?: boolean
  selectedItem?: {
    itemKind: 'entity' | 'relationship'
    id: string
  } | null
}>()

const emit = defineEmits<{
  selectNode: [node: KnowledgeNode]
  selectEdge: [edge: KnowledgeEdge]
  projectDrag: [event: ProjectDragEvent]
}>()

const store = useConsoleStore()
const svg = ref<SVGSVGElement | null>(null)
let controller: GraphController | null = null

onMounted(render)
watch([() => props.graph, () => props.projectVisibility], render, { deep: false })
watch(() => currentLocale(), render)
watch(
  [() => props.selectedItem?.itemKind, () => props.selectedItem?.id],
  applySelection,
)
onBeforeUnmount(() => controller?.destroy())

defineExpose({
  zoomIn: () => controller?.zoomIn(),
  zoomOut: () => controller?.zoomOut(),
  fit: () => controller?.fit(),
  reset: () => controller?.reset(),
  clearSelection: () => controller?.clearSelection(),
  markDropTarget: (nodeId: string | null) => controller?.markDropTarget(nodeId),
  restoreNode: (nodeId: string) => controller?.restoreNode(nodeId),
  selectItem: (itemKind: 'entity' | 'relationship', id: string) =>
    controller?.selectItem(itemKind, id) ?? false,
  focusByNames: (
    names: Set<string>,
    options?: { projectOnly?: boolean; searchMatch?: boolean },
  ) => controller?.focusByNames(names, options) ?? 0,
})

async function render() {
  await nextTick()
  if (!svg.value) return
  controller?.destroy()
  controller = renderKnowledgeGraph(svg.value, props.graph, {
    projectVisibility: props.projectVisibility,
    onNodeSelect: (node) => emit('selectNode', node),
    onEdgeSelect: (edge) => emit('selectEdge', edge),
    organize: {
      enabled: () => Boolean(props.organizeProjects),
      onProjectDrag: (event) => emit('projectDrag', event),
    },
  })
  applySelection()
  void showProjectLeads(controller)
}

// A project node carries its personal project id as attributes.projectId.
const projectIdOf = (node: KnowledgeNode) => String(node.attributes?.projectId ?? '')

// Each project node shows its lead's portrait once the leads are read; a
// graph drawn again meanwhile ignores this answer.
async function showProjectLeads(drawn: GraphController) {
  const spaceId = store.activePersonalSpace?.id
  const projectIds = props.graph.nodes.filter(isProjectNode).map(projectIdOf).filter(Boolean)
  if (!spaceId || !projectIds.length) return
  const leads = await loadProjectLeads(spaceId, projectIds)
  if (drawn !== controller) return
  drawn.showProjectLeads((node) => {
    const lead = leads.get(projectIdOf(node))
    return lead ? agentAvatarUrl(lead) : null
  })
}

function applySelection() {
  const item = props.selectedItem
  if (item) controller?.selectItem(item.itemKind, item.id)
}
</script>

<template>
  <svg
    id="knowledge-graph"
    ref="svg"
    class="knowledge-graph-canvas"
    viewBox="0 0 1000 620"
    role="img"
    :aria-label="t('knowledge.workspace.graph.aria')"
  />
</template>
