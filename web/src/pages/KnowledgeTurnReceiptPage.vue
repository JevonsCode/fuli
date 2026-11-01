<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import PageColumns from '@/components/PageColumns.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import KnowledgeItemSummaryCard from '@/features/knowledge-quick-edit/KnowledgeItemSummaryCard.vue'
import { itemEditPath, type TurnReceipt } from '@/features/knowledge-quick-edit/model'
import { readTurnReceipt } from '@/features/knowledge-quick-edit/quick-edit-api'
import { t } from '@/i18n'

// Everything one turn saved, for a receipt too long to list in the reply
// (rec#20). Read back from the Provider; each item opens its own quick edit.
const route = useRoute()
const spaceId = computed(() => String(route.params.spaceId ?? ''))
const episodes = computed(() => String(route.query.episodes ?? '').split(',').filter(Boolean))

const receipt = ref<TurnReceipt | null>(null)
const loading = ref(false)
const error = ref('')
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !receipt.value))

async function load() {
  loading.value = true
  error.value = ''
  try {
    receipt.value = await readTurnReceipt(spaceId.value, episodes.value)
  } catch (cause) {
    error.value = (cause as Error).message
  } finally {
    loading.value = false
  }
}

watch([spaceId, episodes], () => { receipt.value = null; void load() }, { immediate: true })
</script>

<template>
  <section class="view">
  <div class="flex w-full flex-col gap-4" data-turn-receipt>
    <GrowthLoading v-if="showLoading" :label="t('knowledgeQuickEdit.loadingTurn')" />
    <div v-else-if="error" role="alert" class="grid justify-items-start gap-2">
      <p class="m-0">{{ t('knowledgeQuickEdit.turnLoadFailed', { error }) }}</p>
      <Button variant="outline" size="sm" @click="load">{{ t('knowledgeQuickEdit.retry') }}</Button>
    </div>
    <template v-else-if="receipt">
      <p class="m-0 text-sm text-muted-foreground" data-turn-count>
        {{ receipt.entries.length ? t('knowledgeQuickEdit.turn.count', { count: receipt.entries.length }) : t('knowledgeQuickEdit.turn.empty') }}
      </p>
      <p v-if="receipt.deleted_count" class="m-0 text-sm text-muted-foreground" data-turn-deleted>
        {{ t('knowledgeHardDelete.receipt.deleted', { count: receipt.deleted_count }) }}
      </p>
      <PageColumns role="list">
        <div v-for="entry in receipt.entries" :key="`${entry.item_kind}:${entry.item_id}`" role="listitem" class="grid gap-2"
          :data-turn-entry="entry.item_id">
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="entry.change === 'created' ? 'default' : 'secondary'">{{ t(`knowledgeQuickEdit.turn.changed.${entry.change}`) }}</Badge>
            <RouterLink :to="itemEditPath(spaceId, entry)" class="text-sm font-medium underline">
              {{ t('knowledgeQuickEdit.turn.open') }} · {{ entry.title }}
            </RouterLink>
          </div>
          <KnowledgeItemSummaryCard :item="entry" />
        </div>
      </PageColumns>
    </template>
  </div>
  </section>
</template>
