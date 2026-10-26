<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { t } from '@/i18n'
import { useHardDeleteDialog } from './useHardDeleteDialog'
import KnowledgeHardDeleteDialog from './KnowledgeHardDeleteDialog.vue'
import KnowledgeHardDeletedNotice from './KnowledgeHardDeletedNotice.vue'
import type { HardDeletedState } from './model'
import type { SourceDeleteTarget } from './source-delete-model'
const props = defineProps<{ target: SourceDeleteTarget; spaceId: string; label?: string }>()
const emit = defineEmits<{ deleted: [state: HardDeletedState] }>()
const { open, pending, changeOpen, guardDismiss } = useHardDeleteDialog()
const state = ref<HardDeletedState | null>(null)
const opener = ref<HTMLElement | null>(null)
function deleted(value: HardDeletedState) { open.value = false; state.value = value; emit('deleted', value) }
function returnFocus(event: Event) { event.preventDefault(); opener.value?.querySelector('button')?.focus({ preventScroll: true }) }
watch(() => [props.spaceId, props.target.item_kind, props.target.item_id], () => { open.value = false; state.value = null })
</script>
<template>
  <KnowledgeHardDeletedNotice v-if="state" :state="state" :space-id="spaceId" :item-kind="target.item_kind" :item-id="target.item_id"
    @changed="deleted" @present="state = null" />
  <span v-else ref="opener">
    <Button variant="link" size="sm" class="h-auto whitespace-normal text-left text-destructive" :data-source-delete-open="target.item_kind" @click="open = true">
      {{ label || t(`knowledgeHardDelete.source.${target.item_kind}Open`) }}
    </Button>
  </span>
  <Dialog :open="open" @update:open="changeOpen">
    <DialogContent v-if="open" size="lg" :show-close-button="!pending" @escape-key-down="guardDismiss" @interact-outside="guardDismiss" data-source-delete-dialog @close-auto-focus="returnFocus">
      <KnowledgeHardDeleteDialog :item="target" :space-id="spaceId" @deleted="deleted" @cancel="changeOpen(false)" @pending="pending = $event" />
    </DialogContent>
  </Dialog>
</template>
