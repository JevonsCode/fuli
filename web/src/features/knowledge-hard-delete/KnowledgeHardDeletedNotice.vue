<script setup lang="ts">
import { computed } from 'vue'

import { Card } from '@/components/ui/card'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import type { HardDeletedState } from './model'

// rec#5 C9: what an item page shows once the item was permanently deleted,
// whether the person just did it or follows an old link (410). The trace
// holds no content, so neither does this.
const props = defineProps<{ state: HardDeletedState }>()

const when = computed(() => props.state.deletedAt
  ? formatDateTime(props.state.deletedAt, currentLocale(), DATE_TIME_MINUTE, { missing: '—' }) : null)
const failedStores = computed(() => (props.state.result?.local_stores ?? []).filter((store) => store.status === 'failed'))
</script>

<template>
  <Card as="section" class="grid gap-2 px-5 py-5 text-sm" role="status" data-hard-deleted>
    <p class="m-0">{{ t('knowledgeHardDelete.deleted.body') }}</p>
    <p v-if="when" class="m-0 text-muted-foreground" data-hard-deleted-when>{{ t('knowledgeHardDelete.deleted.when', { time: when }) }}</p>
    <p v-if="state.result" class="m-0 text-muted-foreground" data-hard-deleted-count>
      {{ t('knowledgeHardDelete.deleted.done', { count: state.result.counts.items }) }}
    </p>
    <p v-for="store in failedStores" :key="store.store" role="alert" class="m-0 text-destructive" data-hard-deleted-local-failed>
      {{ t('knowledgeHardDelete.deleted.localFailed', { store: store.store, reason: store.reason ?? '' }) }}
    </p>
  </Card>
</template>
