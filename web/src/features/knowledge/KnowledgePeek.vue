<script setup lang="ts">
import { computed } from 'vue'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeItem } from '@/types'
import KnowledgeInspector from './KnowledgeInspector.vue'
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
const emit = defineEmits<{ close: [] }>()

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
}
</script>

<template>
  <Dialog :open="open" @update:open="openChange">
    <DialogContent v-if="item" size="lg" data-knowledge-peek @open-auto-focus="openAutoFocus" @close-auto-focus="closeAutoFocus">
      <DialogHeader class="pr-8">
        <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ title }}</DialogTitle>
        <DialogDescription class="[overflow-wrap:anywhere]">{{ description }}</DialogDescription>
      </DialogHeader>
      <KnowledgeInspector :key="`${item.itemKind}:${item.id}`" v-bind="$attrs" :item="item" :graph="graph" :mode="mode" />
    </DialogContent>
  </Dialog>
</template>
