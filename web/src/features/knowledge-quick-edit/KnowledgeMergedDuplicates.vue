<script setup lang="ts">
import { computed, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { EditFailure, ItemVersion, KnowledgeItemSummary, KnowledgeItemView } from './model'
import { useRevisionAction } from './useRevisionAction'

// The copies an automatic duplicate merge folded into this item (rec#88):
// one short line on the current item, and a split for each copy. A split is
// the person's restore of that copy: it is current on its own again, takes
// its sources back, and is never merged automatically again.
const props = defineProps<{ item: KnowledgeItemView; spaceId: string }>()
const emit = defineEmits<{ split: []; failed: [reason: EditFailure] }>()

const merged = computed(() => (props.item.versions ?? []).filter(version => version.merged_duplicate))
const target = ref<ItemVersion | null>(null)
const action = useRevisionAction(() => target.value as unknown as KnowledgeItemSummary, {
  done: () => {
    emit('split')
    return t('knowledgeQuickEdit.duplicates.done')
  },
  failed: (failure) => emit('failed', failure),
})

function split(version: ItemVersion) {
  target.value = version
  void action.submit({ personalSpaceId: props.spaceId, action: 'restore',
    reason: t('knowledgeQuickEdit.duplicates.splitReason') })
}
</script>

<template>
  <section v-if="merged.length || action.message.value" class="grid gap-1 text-sm text-muted-foreground" data-merged-duplicates>
    <div v-if="merged.length" class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span data-merged-count>{{ t('knowledgeQuickEdit.duplicates.merged', { count: merged.length }) }}</span>
      <Button v-if="merged.length === 1" variant="link" size="sm" class="h-auto p-0 select-none" data-split-duplicate
        :loading="action.pending.value" :loading-label="t('knowledgeQuickEdit.duplicates.splitting')"
        @click="split(merged[0]!)">{{ t('knowledgeQuickEdit.duplicates.split') }}</Button>
    </div>
    <ul v-if="merged.length > 1" class="m-0 grid list-none gap-1 p-0">
      <li v-for="version in merged" :key="version.item_id" class="flex min-w-0 items-center gap-3">
        <span class="min-w-0 flex-1 truncate" :title="version.content">{{ version.content }}</span>
        <Button variant="link" size="sm" class="h-auto shrink-0 p-0 select-none" data-split-duplicate
          :loading="action.pending.value && target?.item_id === version.item_id"
          :disabled="action.pending.value && target?.item_id !== version.item_id"
          :loading-label="t('knowledgeQuickEdit.duplicates.splitting')"
          @click="split(version)">{{ t('knowledgeQuickEdit.duplicates.split') }}</Button>
      </li>
    </ul>
    <p v-if="action.message.value" :role="action.message.value.kind === 'status' ? 'status' : 'alert'" class="m-0"
      :class="action.message.value.kind === 'status' ? 'text-success' : 'text-destructive'" data-split-message>
      {{ action.message.value.text }}
    </p>
  </section>
</template>
