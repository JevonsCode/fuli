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
/* The page fills the window above the dock; the list and the conversation each scroll inside it. */
.rt-view { display: flex; flex-direction: column; overflow: hidden; }
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
