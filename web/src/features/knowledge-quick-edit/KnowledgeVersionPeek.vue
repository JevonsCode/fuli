<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import KnowledgeItemSummaryCard from './KnowledgeItemSummaryCard.vue'
import {
  changedByLabel, itemEditPath, type ItemVersion, type KnowledgeItemView,
} from './model'
import { readKnowledgeItem } from './quick-edit-api'

// One version in the item page's quick look (D-03): what it said, where it
// stands, who wrote it and why, read back from the Provider, with the way to
// its own full page. It renders inside the page's Dialog.
const props = defineProps<{ spaceId: string; version: Pick<ItemVersion, 'item_kind' | 'item_id'>; known?: ItemVersion | null }>()
const emit = defineEmits<{ close: [] }>()

const view = ref<KnowledgeItemView | null>(null)
const error = ref('')
let request = 0

watch(() => [props.spaceId, props.version.item_kind, props.version.item_id], async () => {
  const current = ++request
  view.value = null
  error.value = ''
  try {
    const value = await readKnowledgeItem(props.spaceId, props.version.item_kind, props.version.item_id)
    if (current === request) view.value = value
  } catch (cause) {
    if (current === request) error.value = (cause as Error).message
  }
}, { immediate: true })

const when = (value?: string | null) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
</script>

<template>
  <DialogHeader>
    <!-- The card below names the version's state; the header says when and by whom. -->
    <DialogTitle class="pr-8 text-xl leading-tight [overflow-wrap:anywhere]">
      {{ t('knowledgeQuickEdit.history.versions') }} · {{ when(known?.created_at ?? view?.created_at) }}
    </DialogTitle>
    <DialogDescription>{{ changedByLabel(known?.changed_by) }}</DialogDescription>
  </DialogHeader>
  <GrowthLoading v-if="!view && !error" variant="compact" :label="t('knowledgeQuickEdit.versionPeek.loading')" />
  <p v-else-if="error" role="alert" class="m-0 text-sm text-destructive">{{ t('knowledgeQuickEdit.versionPeek.failed', { error }) }}</p>
  <template v-else-if="view">
    <KnowledgeItemSummaryCard :item="view" />
    <p v-if="known?.reason" class="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-version-reason>
      {{ t('knowledgeQuickEdit.history.reason', { reason: known.reason }) }}
    </p>
  </template>
  <DialogFooter class="border-t pt-4">
    <Button variant="outline" data-peek-close @click="emit('close')">{{ t('common.actions.close') }}</Button>
    <Button as-child data-version-open>
      <RouterLink :to="itemEditPath(spaceId, version)">{{ t('knowledgeQuickEdit.versionPeek.open') }}</RouterLink>
    </Button>
  </DialogFooter>
</template>
