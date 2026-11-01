<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { UiIcon, UiIconButton } from '@/ui'
import type { RoundtableChatRoom, RoundtableThreadSummary } from './roundtable-api'
import { chatRoomName, threadDelivery, type ConversationDelivery } from './roundtable-model'
import { exampleNames } from './roundtable-prompts'
import RoundtablePrompts from './RoundtablePrompts.vue'
import RoundtableRow from './RoundtableRow.vue'
import type { Roundtable } from './useRoundtable'

// The conversation list, like Discord's channel column: 即时对话 (a post wakes
// the Agent now) above 留言板 (it waits for the Agent's next work), the open
// one lifted as a card. It scrolls by itself; its head (how Agents start
// talking, fold) never moves. Folded, it is a rail of portraits.
const props = defineProps<{ rt: Roundtable; collapsed: boolean; foldable: boolean }>()
const emit = defineEmits<{ toggle: []; open: [key: string] }>()
const route = useRoute()

interface ListRow {
  key: string; to: string; people: { agentId: string | null; name: string | null }[]; title: string; preview: string
  updatedAt: string; waiting: string | null; delivery: ConversationDelivery; testId: string
}

// Times read like Messages: today shows the time, earlier days the date.
function listTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return ''
  const today = new Date().toDateString() === date.toDateString()
  return new Intl.DateTimeFormat(currentLocale(), today ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date)
}
const waitingLabel = (item: RoundtableThreadSummary) => item.waiting
  ? (item.waitingFor?.length ? t('roundtable.waitingFor', { names: item.waitingFor.join('、') }) : t('roundtable.waiting'))
  : null
// The person's own messages carry no Agent name.
const threadRow = (item: RoundtableThreadSummary): ListRow => ({
  key: `thread:${item.id}`, to: `/roundtables/${encodeURIComponent(item.id)}`, people: item.participants, title: item.subject,
  preview: item.last ? `${item.last.from ?? t('roundtable.you')}：${item.last.body}` : '', updatedAt: item.updatedAt,
  waiting: waitingLabel(item), delivery: threadDelivery(item), testId: 'roundtable-thread',
})
const roomRow = (item: RoundtableChatRoom): ListRow => ({
  key: `chat:${item.chatId}`, to: `/roundtables/chat/${encodeURIComponent(item.chatId)}`, people: item.members, title: chatRoomName(item),
  preview: `${t(`roundtable.chat.kinds.${item.kind}`)} · ${t('roundtable.chat.memberCount', { count: item.members.length })}`,
  updatedAt: item.updatedAt, waiting: null, delivery: 'instant', testId: 'roundtable-chat-room',
})
const groups = computed(() => {
  const threads = props.rt.threads.value.map(threadRow)
  const rows: Record<ConversationDelivery, ListRow[]> = {
    instant: [...threads.filter(row => row.delivery === 'instant'), ...props.rt.chats.value.map(roomRow)],
    board: threads.filter(row => row.delivery === 'board'),
  }
  return (['instant', 'board'] as const).map(delivery => ({ delivery, rows: rows[delivery] })).filter(group => group.rows.length)
})
const activeKey = computed(() => typeof route.params.threadId === 'string' ? `thread:${route.params.threadId}`
  : typeof route.params.chatId === 'string' ? `chat:${route.params.chatId}` : '')
const names = computed(() => exampleNames(props.rt.threads.value, props.rt.chats.value))
const total = computed(() => props.rt.threads.value.length + props.rt.chats.value.length)
</script>

<template>
  <nav class="rt-list-pane" :class="{ 'is-collapsed': collapsed }" :aria-label="t('roundtable.threads')" data-roundtable-list>
    <header class="rt-list-head">
      <RoundtablePrompts :names="names" :compact="collapsed" />
      <UiIconButton v-if="foldable" size="sm" icon="sidebar"
        :label="t(collapsed ? 'roundtable.list.expand' : 'roundtable.list.collapse')" :aria-expanded="!collapsed" data-roundtable-fold @click="emit('toggle')" />
    </header>
    <div class="rt-list-body">
      <span class="ui-sr-only" role="status" tabindex="-1" data-roundtable-list-head>{{ t('roundtable.count', { count: total }) }}</span>
      <GrowthLoading v-if="rt.listLoading.value" variant="compact" :label="t('roundtable.loading')" />
      <div v-else-if="rt.listsFailed.value" class="rt-list-state" role="alert" data-roundtable-lists-failed>
        <p>{{ t('roundtable.loadFailed') }}</p>
        <Button size="sm" variant="outline" @click="rt.retryLists">{{ t('roundtable.retry') }}</Button>
      </div>
      <p v-else-if="rt.empty.value" class="rt-list-state" data-roundtable-empty>{{ t('roundtable.empty') }}</p>
      <template v-else>
        <template v-if="!collapsed">
          <p v-if="rt.threadsState.value === 'failed' && !rt.accessNotice.value" class="rt-note" role="alert">
            {{ t('roundtable.threadsFailed') }} <Button size="sm" variant="ghost" @click="rt.loadThreads()">{{ t('roundtable.retry') }}</Button>
          </p>
          <p v-else-if="rt.threadsStale.value" class="rt-note" role="status">{{ t('roundtable.stale') }}</p>
          <p v-if="rt.remoteUnavailable.value" class="rt-note">{{ t('roundtable.chat.remoteUnavailable') }}</p>
          <p v-if="rt.chatsState.value === 'failed' && !rt.accessNotice.value" class="rt-note" role="status">
            {{ t('roundtable.chatsFailed') }} <Button size="sm" variant="ghost" @click="rt.loadChats()">{{ t('roundtable.retry') }}</Button>
          </p>
          <p v-else-if="rt.chatsStale.value" class="rt-note" role="status" data-roundtable-chats-stale>{{ t('roundtable.chatsStale') }}</p>
        </template>
        <section v-for="group in groups" :key="group.delivery" class="rt-group" :aria-labelledby="`rt-group-${group.delivery}`" :data-roundtable-group="group.delivery">
          <h2 :id="`rt-group-${group.delivery}`" class="rt-group-label" :title="collapsed ? t(`roundtable.list.${group.delivery}`) : undefined">
            <UiIcon :name="group.delivery" :size="13" />
            <span :class="{ 'ui-sr-only': collapsed }">{{ t(`roundtable.list.${group.delivery}`) }}</span>
            <span v-if="!collapsed" class="ui-num">{{ group.rows.length }}</span>
          </h2>
          <ul class="rt-rows">
            <RoundtableRow v-for="row in group.rows" :key="row.key" :to="row.to" :people="row.people" :title="row.title" :preview="row.preview"
              :time="listTime(row.updatedAt)" :datetime="row.updatedAt" :waiting="row.waiting" :delivery="row.delivery"
              :active="row.key === activeKey" :collapsed="collapsed" :data-roundtable-key="row.key" :data-testid="row.testId" @click="emit('open', row.key)" />
          </ul>
        </section>
        <GrowthLoading v-if="rt.chatsState.value === 'loading'" variant="compact" :label="t('roundtable.loading')" />
        <template v-if="!collapsed">
          <p v-if="rt.threads.value.length >= 50" class="rt-note">{{ t('roundtable.latest50') }}</p>
          <p v-if="rt.localMoreFailed.value" role="alert" class="rt-note">{{ t('roundtable.localMoreFailed') }}</p>
        </template>
        <Button v-if="rt.hasMoreChats.value" class="rt-more" size="sm" variant="ghost" :loading="rt.loadingMoreChats.value"
          :loading-label="t('roundtable.loadingMoreChats')" :aria-label="collapsed ? t('roundtable.loadMoreChats') : undefined" data-roundtable-more-chats
          @click="rt.loadMoreChats"><UiIcon v-if="collapsed" name="more" :size="16" /><template v-else>{{ t('roundtable.loadMoreChats') }}</template></Button>
      </template>
    </div>
  </nav>
</template>

<style scoped>
.rt-list-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.rt-list-head { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 6px; padding: 0 4px 10px; }
.is-collapsed .rt-list-head { flex-direction: column-reverse; justify-content: flex-start; }
.rt-list-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 14px; min-height: 0; padding: 2px 2px 12px; overflow-y: auto; overscroll-behavior: contain; }
.rt-list-body > [data-roundtable-list-head] { outline: none; }
.rt-group { display: grid; gap: 2px; }
.rt-group-label {
  display: flex; align-items: center; gap: 6px; margin: 0; padding: 0 10px 4px; color: var(--color-muted);
  font-size: var(--text-meta); font-weight: var(--weight-medium); user-select: none;
}
.rt-group-label .ui-num { margin-left: auto; color: var(--color-faint); }
.is-collapsed .rt-group-label { justify-content: center; padding-inline: 0; }
.is-collapsed .rt-group + .rt-group { padding-top: 10px; border-top: 1px solid var(--color-border); }
.rt-rows { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.rt-note { margin: 0; padding-inline: 10px; color: var(--color-muted); font-size: var(--text-meta); }
.rt-list-state { display: grid; justify-items: start; gap: 8px; margin: 0; padding: 8px 10px; color: var(--color-muted); font-size: var(--text-control); }
.rt-list-state p { margin: 0; }
.is-collapsed .rt-list-state { justify-items: center; padding-inline: 0; text-align: center; }
.rt-more { align-self: center; }
</style>
