<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { UiNotice } from '@/ui'
import { useRoundtableListCollapse } from './roundtable-list-collapse'
import { rememberPlace, restorePlace, type ListPlace } from './roundtable-scroll'
import RoundtableDetail from './RoundtableDetail.vue'
import RoundtableList from './RoundtableList.vue'
import { useRoundtable } from './useRoundtable'
import { usePageRefresh } from '@/layouts/page-refresh'

// 圆桌 (11-02): where Agents talk to each other, laid out like Discord. The
// conversation list on one side, the open conversation on the other, each
// scrolling by itself; the list folds to portraits. A narrow window shows them
// as two steps, list then conversation. The data and its live updates come from
// useRoundtable; this page only lays them out.
const NARROW = '(max-width: 767px)'
const narrow = useMediaQuery(NARROW)
const { collapsed, toggle } = useRoundtableListCollapse()
const listCollapsed = computed(() => collapsed.value && !narrow.value)

// Back to the list (a narrow window) returns to the row the person opened, never to the top.
const listElement = () => document.querySelector<HTMLElement>('[data-roundtable-list]')
let place: ListPlace | null = null
function remember(key: string) { place = rememberPlace(listElement(), key) }
const rt = useRoundtable({
  detailReady: async () => {
    await nextTick()
    document.querySelector<HTMLElement>('[data-roundtable-detail-title]')?.focus({ preventScroll: true })
  },
  backToList: async () => {
    const saved = place
    if (!saved) return
    await nextTick()
    await restorePlace(listElement(), saved, () => document.querySelector<HTMLElement>('[data-roundtable-list-head]'))
  },
  cleared: () => { place = null },
})
const showList = computed(() => !narrow.value || !rt.hasSelection.value)
const showDetail = computed(() => !narrow.value || rt.hasSelection.value)
// The top bar's 刷新 reads both lists again; the open conversation stays live on its own.
usePageRefresh(() => Promise.all([rt.loadThreads(), rt.loadChats()]))
</script>

<template>
  <section class="view rt-view">
    <div class="rt" :class="{ 'is-collapsed': listCollapsed, 'is-narrow': narrow }">
      <UiNotice v-if="rt.accessNotice.value" class="rt-notice" tone="error">
        {{ t('roundtable.accessLost') }}
        <template #actions><Button size="sm" variant="ghost" @click="rt.reloadAll">{{ t('roundtable.retry') }}</Button></template>
      </UiNotice>
      <UiNotice v-if="rt.liveDisconnected.value" class="rt-notice" :tone="rt.reloadFailed.value ? 'error' : 'warning'" data-roundtable-live>
        {{ t('roundtable.liveDisconnected') }}<template v-if="rt.reloadFailed.value"> {{ t('roundtable.reloadFailed') }}</template>
        <template #actions><Button size="sm" variant="ghost" :loading="rt.reconnecting.value" :loading-label="t('roundtable.reloading')" @click="rt.reconnected">{{ t('roundtable.reload') }}</Button></template>
      </UiNotice>
      <RoundtableList v-show="showList" :rt="rt" :collapsed="listCollapsed" :foldable="!narrow" @toggle="toggle" @open="remember" />
      <RoundtableDetail v-if="showDetail" :rt="rt" :narrow="narrow" />
    </div>
  </section>
</template>

<style scoped>
/* The list and the conversation fill the window down to its bottom edge, under the floating dock
   (Jevons 11-02); each scrolls inside itself and keeps its last line and the composer clear of the dock. */
.rt-view { --rt-dock-room: calc(var(--dock-clearance) - 40px); display: flex; flex-direction: column; overflow: hidden; padding-bottom: 20px !important; }
/* The dock floats over the list column, not the conversation (Jevons 11-06): the composer keeps
   no dock room beside the list, only when the conversation takes the whole width. */
.rt.is-narrow :deep(.rt-composer) { padding-bottom: var(--rt-dock-room); }
.rt :deep(.rt-chat:not(.roundtable-thread-chat) .rt-chat-body), .rt :deep(.rt-list-body) { padding-bottom: var(--rt-dock-room); }
.rt {
  --rt-list-width: 300px;
  display: grid; flex: 1 1 0; grid-template-columns: var(--rt-list-width) minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr);
  column-gap: 20px; width: 100%; min-height: 0;
}
.rt.is-collapsed { --rt-list-width: 64px; }
.rt-notice { grid-column: 1 / -1; margin-bottom: 12px; }
.rt > :deep(.rt-list-pane), .rt > :deep(.rt-detail-pane) { grid-row: 3; }
.rt.is-narrow { grid-template-columns: minmax(0, 1fr); }
</style>
