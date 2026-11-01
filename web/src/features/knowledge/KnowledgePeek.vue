<script setup lang="ts">
import { computed, useAttrs } from 'vue'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeItem, KnowledgeNode } from '@/types'
import KnowledgeInspector from './KnowledgeInspector.vue'
import ProjectPeek from './ProjectPeek.vue'
import { profileAspectLabel } from './model'

// One knowledge item's quick look (D-03): a centred dialog over the page's one
// canvas instead of an inspector column beside the list. The page owns which
// item is open; every other prop and event goes straight to the inspector.
// While a form the inspector opened (edit, confirm, project) is on screen the
// quick look steps aside (`suspended`) and comes back on the same item, so
// only one modal is open at a time.
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  item: KnowledgeItem | null
  graph: KnowledgeGraph | null
  mode?: 'directory' | 'graph' | 'preference'
  suspended?: boolean
}>()
// closeAutoFocus lets a page send focus back itself (its opener, or a row after
// a direct link); without a listener the dialog's own return applies.
const emit = defineEmits<{ close: []; closeAutoFocus: [event: Event]; selectProject: [projectId: string] }>()

// A project gets its own quick look (ProjectPeek): what it is, who works on
// it and where it sits, instead of the knowledge inspector's fields and IDs.
const attrs = useAttrs()
const store = useConsoleStore()
const projectNode = computed(() => {
  const item = props.item
  const node = item?.itemKind === 'entity' ? item.raw as KnowledgeNode : null
  return node && (node.type === 'PersonalProject' || node.type === 'RelatedPersonalProject') ? node : null
})
const project = computed(() => {
  const id = projectNode.value?.attributes?.projectId
  return store.state?.personalProjects?.find(candidate => candidate.project_id === id) ?? null
})
const spaceId = computed(() => String(attrs.spaceId ?? attrs['space-id'] ?? ''))
// The page's own handlers, passed down as attributes like the inspector's.
function forward(name: 'onOpenProject' | 'onManageProject', value: unknown) {
  const handler = attrs[name]
  if (typeof handler === 'function') handler(value)
}

const open = computed(() => Boolean(props.item) && !props.suspended)
const title = computed(() => {
  const item = props.item
  if (!item) return ''
  return item.itemKind === 'entity' ? item.title : (item.raw as KnowledgeEdge).type
})
// A preference shows its full text in the detail itself; the header names its aspect.
const description = computed(() => {
  const item = props.item
  if (!item) return ''
  if (projectNode.value) return ''
  return props.mode === 'preference' ? profileAspectLabel(item.profileAspect) : item.body
})

function openChange(value: boolean) {
  if (!value) emit('close')
}
// Opening focuses the dialog itself, so a keyboard reader starts at the top
// instead of on whichever disclosure happens to come first.
function openAutoFocus(event: Event) {
  event.preventDefault()
  ;(event.target as HTMLElement | null)?.focus({ preventScroll: true })
}
// Stepping aside for a form: that form takes focus, not the row behind.
function closeAutoFocus(event: Event) {
  if (props.suspended) event.preventDefault()
  else emit('closeAutoFocus', event)
}
</script>

<template>
  <Dialog :open="open" @update:open="openChange">
    <DialogContent v-if="item" size="lg" data-knowledge-peek @open-auto-focus="openAutoFocus" @close-auto-focus="closeAutoFocus">
      <DialogHeader class="pr-8">
        <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ title }}</DialogTitle>
        <DialogDescription :class="description ? '[overflow-wrap:anywhere]' : 'sr-only'">{{ description || title }}</DialogDescription>
      </DialogHeader>
      <ProjectPeek v-if="projectNode" :key="item.id" :item="item" :graph="graph" :project="project" :space-id="spaceId"
        @open-project="forward('onOpenProject', $event)" @edit-project="forward('onManageProject', $event)" @select-project="emit('selectProject', $event)" />
      <KnowledgeInspector v-else :key="`${item.itemKind}:${item.id}`" v-bind="$attrs" :item="item" :graph="graph" :mode="mode" />
    </DialogContent>
  </Dialog>
</template>
