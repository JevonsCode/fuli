<script setup lang="ts">
import { ref } from 'vue'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { KnowledgeItemSummary } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import { useHardDeleteDialog } from './useHardDeleteDialog'
import KnowledgeHardDeleteDialog from './KnowledgeHardDeleteDialog.vue'
import type { SourceDeleteTarget } from './source-delete-model'
import type { HardDeletedState } from './model'

// rec#11 D-88: every knowledge item and relationship is one click from its
// delete dialog. Only the console offers it.
withDefaults(defineProps<{
  item: Pick<KnowledgeItemSummary, 'item_kind' | 'item_id'> | SourceDeleteTarget
  spaceId: string
  label?: string
  size?: 'default' | 'sm'
}>(), { label: undefined, size: 'default' })
const emit = defineEmits<{ deleted: [state: HardDeletedState] }>()

const { open, pending, changeOpen, guardDismiss } = useHardDeleteDialog()
const opener = ref<HTMLElement | null>(null)

function deleted(state: HardDeletedState) {
  open.value = false
  emit('deleted', state)
}

function returnFocus(event: Event) {
  event.preventDefault()
  opener.value?.querySelector('button')?.focus({ preventScroll: true })
}
</script>

<template>
  <span ref="opener" class="contents">
    <Button variant="destructive" :size="size" data-hard-delete-open @click="open = true">{{ label ?? t('knowledgeHardDelete.danger.open') }}</Button>
  </span>
  <Dialog :open="open" @update:open="changeOpen">
    <DialogContent v-if="open" size="lg" :show-close-button="!pending" @escape-key-down="guardDismiss" @interact-outside="guardDismiss" data-hard-delete-dialog @close-auto-focus="returnFocus">
      <KnowledgeHardDeleteDialog :item="item" :space-id="spaceId" @deleted="deleted" @cancel="changeOpen(false)" @pending="pending = $event" />
    </DialogContent>
  </Dialog>
</template>
