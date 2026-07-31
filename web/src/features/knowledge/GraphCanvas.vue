<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { currentLocale, t } from '@/i18n'
import { renderKnowledgeGraph, type GraphController } from './graph-runtime'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/types'

const props = defineProps<{
  graph: KnowledgeGraph
  selectedItem?: {
    itemKind: 'entity' | 'relationship'
    id: string
  } | null
}>()

const emit = defineEmits<{
  selectNode: [node: KnowledgeNode]
  selectEdge: [edge: KnowledgeEdge]
}>()

const svg = ref<SVGSVGElement | null>(null)
let controller: GraphController | null = null

onMounted(render)
watch(() => props.graph, render, { deep: false })
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
    onNodeSelect: (node) => emit('selectNode', node),
    onEdgeSelect: (edge) => emit('selectEdge', edge),
  })
  applySelection()
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
