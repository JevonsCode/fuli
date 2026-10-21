<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import type { ItemKind } from '@/features/knowledge-quick-edit/model'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { hardDeleteStatus } from './hard-delete-api'
import { deletedState, ledgerDamage, type HardDeletedState } from './model'

// rec#5 C9: what an item page shows once a permanent delete was sent or an
// old link answered 410. Three states the console tells apart: the result
// is not known yet (it asks the graph again, never deletes again), the graph
// deleted it and local cleanup is left, or everything is done. An old link
// asks once on its own so a cleanup that a crash cut short finishes. The
// trace holds no content, so neither does this.
const props = defineProps<{ state: HardDeletedState; spaceId: string; itemKind: ItemKind; itemId: string }>()
const emit = defineEmits<{ changed: [state: HardDeletedState]; present: [] }>()

const checking = ref(false)
const damage = ref<string | null>(null)
const when = computed(() => props.state.deletedAt
  ? formatDateTime(props.state.deletedAt, currentLocale(), DATE_TIME_MINUTE, { missing: '—' }) : null)
const failedStores = computed(() => (props.state.result?.local_stores ?? []).filter((store) => store.status === 'failed'))
const deleted = computed(() => ['complete', 'local_pending', 'gone'].includes(props.state.outcome))

async function check() {
  checking.value = true
  try {
    const result = await hardDeleteStatus(props.spaceId, { item_kind: props.itemKind, item_id: props.itemId })
    if (result.outcome === 'not_deleted' || result.outcome === 'missing') emit('present')
    else emit('changed', deletedState(result))
  } catch (cause) {
    // Still unknown or still to clean: the state stays as it is, with its
    // retry; a damaged record says how to repair it.
    damage.value = ledgerDamage(cause)
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  if (props.state.outcome !== 'complete') void check()
})
</script>

<template>
  <Card as="section" class="grid gap-2 px-5 py-5 text-sm" role="status" data-hard-deleted :data-hard-deleted-state="state.outcome">
    <GrowthLoading v-if="checking" variant="inline" :label="t('knowledgeHardDelete.deleted.checking')" />
    <p v-if="damage" role="alert" class="m-0 text-destructive" data-hard-deleted-damage>{{ damage }}</p>
    <template v-if="state.outcome === 'unknown'">
      <p class="m-0" data-hard-deleted-unknown>{{ t('knowledgeHardDelete.deleted.unknown') }}</p>
      <div><Button variant="outline" size="sm" :disabled="checking" data-hard-deleted-recheck @click="check">
        {{ t('knowledgeHardDelete.deleted.recheck') }}</Button></div>
    </template>
    <template v-else-if="deleted">
      <p v-if="state.outcome === 'local_pending'" class="m-0" data-hard-deleted-local-pending>{{ t('knowledgeHardDelete.deleted.localPending') }}</p>
      <p v-else class="m-0">{{ t('knowledgeHardDelete.deleted.body') }}</p>
      <p v-if="when" class="m-0 text-muted-foreground" data-hard-deleted-when>{{ t('knowledgeHardDelete.deleted.when', { time: when }) }}</p>
      <p v-if="state.result?.counts" class="m-0 text-muted-foreground" data-hard-deleted-count>
        {{ t('knowledgeHardDelete.deleted.done', { items: state.result.counts.items, episodes: state.result.counts.episodes }) }}
      </p>
      <p v-for="store in failedStores" :key="store.store" role="alert" class="m-0 text-destructive" data-hard-deleted-local-failed>
        {{ t('knowledgeHardDelete.deleted.localFailed', { store: store.store, reason: store.reason ?? '' }) }}
      </p>
      <div v-if="state.outcome === 'local_pending'"><Button variant="outline" size="sm" :disabled="checking"
        data-hard-deleted-retry @click="check">{{ t('knowledgeHardDelete.deleted.retry') }}</Button></div>
      <p class="m-0 text-muted-foreground" data-hard-deleted-exceptions>{{ t('knowledgeHardDelete.deleted.exceptions') }}</p>
      <p class="m-0 text-muted-foreground" data-hard-deleted-disclosure>{{ t('knowledgeHardDelete.deleted.disclosure') }}</p>
      <div><Button variant="link" size="sm" class="h-auto p-0" as-child data-hard-deleted-backups>
        <RouterLink to="/settings/data-format">{{ t('knowledgeHardDelete.deleted.backups') }}</RouterLink></Button></div>
    </template>
  </Card>
</template>
