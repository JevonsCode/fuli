<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { UiIcon, UiNotice } from '@/ui'
import type { RoundtableChatRoom, RoundtableThreadSummary } from './roundtable-api'
import { chatRoomName } from './roundtable-model'
import { rememberPlace, restorePlace, type ListPlace } from './roundtable-scroll'
import RoundtableNewConversation from './RoundtableNewConversation.vue'
import RoundtableRoom from './RoundtableRoom.vue'
import RoundtableRow from './RoundtableRow.vue'
import RoundtableThreadChat from './RoundtableThreadChat.vue'
import { useRoundtable } from './useRoundtable'

// 圆桌 (重写, direction A): the conversations with and between FLAs, like
// Messages. The list shows the person's own conversations first and the rooms
// FLAs keep among themselves after; a conversation opens on its own page with
// a way back, never beside the list. The data and its live updates come from
// useRoundtable; this page only lays them out.
const route = useRoute()
const router = useRouter()

// Back to the list returns to the row the person opened, never to the top.
const listElement = ref<HTMLElement | null>(null)
let place: ListPlace | null = null
function remember(key: string) { place = rememberPlace(listElement.value, key) }
const rt = useRoundtable({
  detailReady: async () => {
    await nextTick()
    document.querySelector<HTMLElement>('[data-roundtable-detail-title]')?.focus({ preventScroll: true })
  },
  backToList: async () => {
    const saved = place
    if (!saved) return
    await nextTick()
    await restorePlace(listElement.value, saved, () => document.querySelector<HTMLElement>('[data-roundtable-list-head]'))
  },
  cleared: () => { place = null },
})
const { threads, chats } = rt

// "← 全部对话" goes Back when the list opened this conversation; a deep link opens the list instead.
const openedFromList = /^\/roundtables\/?(\?.*)?$/
const listPath = computed(() => router.resolve({ path: '/roundtables', query: route.query }).fullPath)
const starting = ref(false)
watch(rt.hasSelection, () => { starting.value = false })


// Times read like Messages: today shows the time, earlier days the date.
function listTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  const today = new Date().toDateString() === date.toDateString()
  return new Intl.DateTimeFormat(currentLocale(), today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date)
}
function time(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
const waitingLabel = (item: RoundtableThreadSummary) => item.waiting
  ? (item.waitingFor?.length ? t('roundtable.waitingFor', { names: item.waitingFor.join('、') }) : t('roundtable.waiting'))
  : null
// The person's own messages carry no Agent name.
const threadPreview = (item: RoundtableThreadSummary) => item.last ? `${item.last.from ?? t('roundtable.you')}：${item.last.body}` : ''
const roomPreview = (item: RoundtableChatRoom) => `${t(`roundtable.chat.kinds.${item.kind}`)} · ${t('roundtable.chat.memberCount', { count: item.members.length })}`
const threadPath = (item: RoundtableThreadSummary) => `/roundtables/${encodeURIComponent(item.id)}`
const roomPath = (item: RoundtableChatRoom) => `/roundtables/chat/${encodeURIComponent(item.chatId)}`
</script>

<template>
  <section class="view rt-view" :class="{ 'is-open': rt.hasSelection.value }">
    <div class="rt">
      <UiNotice v-if="rt.accessNotice.value" tone="error">
        {{ t('roundtable.accessLost') }}
        <template #actions><Button size="sm" variant="ghost" @click="rt.reloadAll">{{ t('roundtable.retry') }}</Button></template>
      </UiNotice>
      <UiNotice v-if="rt.liveDisconnected.value" :tone="rt.reloadFailed.value ? 'error' : 'warning'" data-roundtable-live>
        {{ t('roundtable.liveDisconnected') }}<template v-if="rt.reloadFailed.value"> {{ t('roundtable.reloadFailed') }}</template>
        <template #actions><Button size="sm" variant="ghost" :loading="rt.reconnecting.value" :loading-label="t('roundtable.reloading')" @click="rt.reconnected">{{ t('roundtable.reload') }}</Button></template>
      </UiNotice>

      <!-- An open conversation: its own page with a way back. -->
      <template v-if="rt.hasSelection.value">
        <BackLink class="rt-back" :to="listPath" :from="openedFromList" data-roundtable-back>{{ t('roundtable.back') }}</BackLink>
        <RoundtableThreadChat v-if="rt.thread.value" :thread="rt.thread.value" :time="time" :stale="rt.detailStale.value" @updated="rt.threadUpdated" />
        <RoundtableRoom v-else-if="rt.room.value" :room="rt.room.value" :time="time" :loading-later="rt.loadingLater.value" :later-failed="rt.laterFailed.value"
          :later-stuck="rt.laterStuck.value" :new-messages="rt.newMessages.value" @later="rt.loadLater" />
        <div v-else class="rt-state">
          <template v-if="rt.detailState.value === 'loading'">
            <GrowthLoading variant="compact" :label="t('roundtable.detailLoading')" />
            <p v-if="rt.detailSlow.value" role="status">{{ t('roundtable.detailSlow') }}</p>
          </template>
          <p v-else-if="rt.detailState.value === 'missing'" role="alert">{{ t('roundtable.detailMissing') }}</p>
          <p v-else-if="rt.detailState.value === 'failed'" role="alert">
            {{ t('roundtable.loadFailed') }} <Button size="sm" variant="ghost" @click="rt.loadDetail">{{ t('roundtable.retry') }}</Button>
          </p>
        </div>
      </template>

      <!-- The list of conversations. -->
      <GrowthLoading v-else-if="rt.listLoading.value" :label="t('roundtable.loading')" />
      <div v-else-if="rt.listsFailed.value" class="rt-state is-centred" role="alert" data-roundtable-lists-failed>
        <strong>{{ t('roundtable.loadFailed') }}</strong>
        <p>{{ t('roundtable.loadFailedHint') }}</p>
        <Button @click="rt.retryLists">{{ t('roundtable.retry') }}</Button>
      </div>
      <RoundtableNewConversation v-else-if="starting" @close="starting = false" />
      <div v-else-if="rt.empty.value" class="rt-state is-centred">
        <span class="rt-empty-mark" aria-hidden="true"><UiIcon name="chat" :size="22" /></span>
        <strong>{{ t('roundtable.empty') }}</strong>
        <p>{{ t('roundtable.emptyHint') }}</p>
        <Button data-roundtable-start @click="starting = true">{{ t('roundtable.start.open') }}</Button>
      </div>
      <nav v-else ref="listElement" class="rt-lists" :aria-label="t('roundtable.threads')">
        <header class="rt-bar">
          <span class="rt-count ui-sr-only" role="status" tabindex="-1" data-roundtable-list-head>{{ t('roundtable.count', { count: threads.length + chats.length }) }}</span>
          <Button size="sm" data-roundtable-start @click="starting = true"><UiIcon name="plus" :size="15" />{{ t('roundtable.start.open') }}</Button>
        </header>
        <p v-if="rt.threadsState.value === 'failed' && !rt.accessNotice.value" class="rt-note" role="alert">
          {{ t('roundtable.threadsFailed') }} <Button size="sm" variant="ghost" @click="rt.loadThreads()">{{ t('roundtable.retry') }}</Button>
        </p>
        <p v-else-if="rt.threadsStale.value" class="rt-note" role="status">{{ t('roundtable.stale') }}</p>

        <section v-if="threads.length" class="rt-group" aria-labelledby="rt-mine">
          <h2 id="rt-mine" class="rt-group-label">{{ t('roundtable.sections.mine') }} <span class="ui-num">{{ threads.length }}</span></h2>
          <ul class="rt-list">
            <RoundtableRow v-for="item in threads" :key="`thread:${item.id}`" :to="threadPath(item)" :people="item.participants" :title="item.subject"
              :preview="threadPreview(item)" :time="listTime(item.updatedAt)" :datetime="item.updatedAt" :waiting="waitingLabel(item)"
              :data-roundtable-key="`thread:${item.id}`" data-testid="roundtable-thread" @click="remember(`thread:${item.id}`)" />
          </ul>
          <p v-if="threads.length >= 50" class="rt-note">{{ t('roundtable.latest50') }}</p>
        </section>

        <section v-if="chats.length || rt.chatsState.value !== 'ready'" class="rt-group" aria-labelledby="rt-flas">
          <h2 id="rt-flas" class="rt-group-label">{{ t('roundtable.sections.flas') }} <span v-if="chats.length" class="ui-num">{{ chats.length }}</span></h2>
          <p v-if="rt.remoteUnavailable.value" class="rt-note">{{ t('roundtable.chat.remoteUnavailable') }}</p>
          <p v-if="rt.chatsState.value === 'failed' && !rt.accessNotice.value" class="rt-note" role="status">
            {{ t('roundtable.chatsFailed') }} <Button size="sm" variant="ghost" @click="rt.loadChats()">{{ t('roundtable.retry') }}</Button>
          </p>
          <p v-else-if="rt.chatsStale.value" class="rt-note" role="status" data-roundtable-chats-stale>{{ t('roundtable.chatsStale') }}</p>
          <GrowthLoading v-if="rt.chatsState.value === 'loading'" variant="compact" :label="t('roundtable.loading')" />
          <ul v-if="chats.length" class="rt-list">
            <RoundtableRow v-for="item in chats" :key="`chat:${item.chatId}`" :to="roomPath(item)" :people="item.members" :title="chatRoomName(item)"
              :preview="roomPreview(item)" :time="listTime(item.updatedAt)" :datetime="item.updatedAt"
              :data-roundtable-key="`chat:${item.chatId}`" data-testid="roundtable-chat-room" @click="remember(`chat:${item.chatId}`)" />
          </ul>
          <p v-if="rt.localMoreFailed.value" role="alert" class="rt-note">{{ t('roundtable.localMoreFailed') }}</p>
          <Button v-if="rt.hasMoreChats.value" class="rt-more" size="sm" variant="ghost" :loading="rt.loadingMoreChats.value"
            :loading-label="t('roundtable.loadingMoreChats')" data-roundtable-more-chats @click="rt.loadMoreChats">{{ t('roundtable.loadMoreChats') }}</Button>
        </section>
      </nav>
    </div>
  </section>
</template>

<style scoped>
.rt-view { display: flex; flex-direction: column; }
/* An open conversation fills the page and scrolls inside, keeping the shell's dock clearance. */
.rt-view.is-open { overflow: hidden; }
.rt { display: flex; flex: 1 0 auto; flex-direction: column; gap: 24px; width: 100%; max-width: 960px; margin-inline: auto; }
.is-open .rt { flex: 1 1 0; gap: 12px; min-height: 0; }
.rt-back { align-self: flex-start; color: var(--color-muted); font-size: var(--text-control); text-decoration: none; }
.rt-back:hover { color: var(--color-ink); }
.rt-bar { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding-inline: 4px; }
/* The total stays for screen readers and as the place focus returns to; each section shows its own count. */
.rt-count { outline: none; }
.rt-lists { display: flex; flex-direction: column; gap: 28px; }
.rt-group { display: grid; gap: 8px; }
.rt-group-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 18px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.rt-group-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.rt-list { margin: 0; padding: 0; list-style: none; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.rt-list > :first-child :deep(.rt-row) { border-start-start-radius: var(--radius-card); border-start-end-radius: var(--radius-card); }
.rt-list > :last-child :deep(.rt-row) { border-end-start-radius: var(--radius-card); border-end-end-radius: var(--radius-card); }
.rt-note { margin: 0; padding-inline: 18px; color: var(--color-muted); font-size: var(--text-meta); }
.rt-more { justify-self: center; }
.rt-state { display: grid; align-content: start; gap: 10px; padding: 16px 4px; color: var(--color-muted); }
.rt-state p { margin: 0; }
.rt-state.is-centred { justify-items: center; max-width: 440px; margin: 10vh auto 0; text-align: center; }
.rt-state.is-centred strong { color: var(--color-ink); font-size: var(--text-section); font-weight: var(--weight-strong); }
.rt-empty-mark { display: grid; width: 52px; height: 52px; place-items: center; border-radius: 50%; color: var(--color-ink-soft); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
@media (max-width: 860px) {
  /* A long title or participant list scrolls away with a room's messages instead of pushing them out of the card;
     a thread keeps its composer at the bottom, so only its messages scroll. */
  .rt :deep(.rt-chat:not(.roundtable-thread-chat)) { overflow-y: auto; overscroll-behavior: contain; }
  .rt :deep(.rt-chat:not(.roundtable-thread-chat) .rt-chat-body) { flex: 0 0 auto; min-height: auto; overflow: visible; }
}
</style>
