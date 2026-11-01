<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { UiIcon } from '@/ui'
import RoundtableRoom from './RoundtableRoom.vue'
import RoundtableThreadChat from './RoundtableThreadChat.vue'
import type { Roundtable } from './useRoundtable'

// The open conversation beside the list: a thread as a chat, an Agent room, or
// where its read stands. On a narrow window the list and the conversation are
// two steps, and the 全部对话 crumb goes back to the list (Back when the list opened it).
defineProps<{ rt: Roundtable; narrow: boolean }>()
const route = useRoute()
const router = useRouter()
const openedFromList = /^\/roundtables\/?(\?.*)?$/
const listPath = computed(() => router.resolve({ path: '/roundtables', query: route.query }).fullPath)

function time(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
</script>

<template>
  <div class="rt-detail-pane">
    <template v-if="rt.hasSelection.value">
      <Breadcrumb v-if="narrow" :parent="{ label: t('roundtable.back'), to: listPath, from: openedFromList }" data-roundtable-back />
      <RoundtableThreadChat v-if="rt.thread.value" :thread="rt.thread.value" :time="time" :stale="rt.detailStale.value" @updated="rt.threadUpdated" />
      <RoundtableRoom v-else-if="rt.room.value" :room="rt.room.value" :time="time" :loading-later="rt.loadingLater.value" :later-failed="rt.laterFailed.value"
        :later-stuck="rt.laterStuck.value" :new-messages="rt.newMessages.value" @later="rt.loadLater" />
      <div v-else class="rt-detail-state">
        <template v-if="rt.detailState.value === 'loading'">
          <GrowthLoading :label="t('roundtable.detailLoading')" />
          <p v-if="rt.detailSlow.value" role="status">{{ t('roundtable.detailSlow') }}</p>
        </template>
        <p v-else-if="rt.detailState.value === 'missing'" role="alert">{{ t('roundtable.detailMissing') }}</p>
        <p v-else-if="rt.detailState.value === 'failed'" role="alert">
          {{ t('roundtable.loadFailed') }} <Button size="sm" variant="ghost" @click="rt.loadDetail">{{ t('roundtable.retry') }}</Button>
        </p>
      </div>
    </template>
    <div v-else class="rt-detail-none" data-roundtable-none>
      <UiIcon name="roundtable" :size="40" />
      <p class="ui-sr-only">{{ t('roundtable.list.none') }}</p>
    </div>
  </div>
</template>

<style scoped>
.rt-detail-pane { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
.rt-detail-state { display: grid; align-content: start; gap: 10px; padding: 16px 4px; color: var(--color-muted); }
.rt-detail-state p { margin: 0; }
.rt-detail-none {
  display: grid; flex: 1 1 auto; place-items: center; border-radius: var(--radius-shell); color: var(--color-faint);
  box-shadow: inset 0 0 0 1px var(--color-border);
}
@media (max-width: 860px) {
  /* A long title or participant list scrolls away with a room's messages instead of pushing them out of the card;
     a thread keeps its composer at the bottom, so only its messages scroll. */
  .rt-detail-pane :deep(.rt-chat:not(.roundtable-thread-chat)) { overflow-y: auto; overscroll-behavior: contain; }
  .rt-detail-pane :deep(.rt-chat:not(.roundtable-thread-chat) .rt-chat-body) { flex: 0 0 auto; min-height: auto; overflow: visible; }
}
</style>
