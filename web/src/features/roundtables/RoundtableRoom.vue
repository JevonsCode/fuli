<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { RoundtableChatPage } from './roundtable-api'
import { chatRoomName } from './roundtable-model'
import { gapToEnd, scrollToEnd, TAIL_FOLLOW_PX } from './roundtable-scroll'
import RoundtableSeats from './RoundtableSeats.vue'

// One Agent chat room, read-only: who is in it and what they said, in order.
// A reader at the end follows new messages; anywhere else they are announced
// with a jump to the first one, never pulled in under the reader's eyes.
const props = defineProps<{
  room: RoundtableChatPage
  time: (value: string) => string
  loadingLater?: boolean
  laterFailed?: boolean
  laterStuck?: boolean
  newMessages?: boolean
  wide?: boolean
}>()
const emit = defineEmits<{ later: [] }>()
const byAddress = computed(() => new Map(props.room.members.map(member => [member.address, member])))
const seats = computed(() => props.room.members.map(member => ({
  key: member.address,
  person: { agentId: member.agentId, name: member.name, client: null },
  spoke: props.room.messages.filter(message => message.from === member.address).length,
  awaited: false,
})))
const sender = (address: string) => byAddress.value.get(address)
const senderName = (address: string) => sender(address)?.name ?? t('roundtable.unknownAgent')
const initial = (address: string) => senderName(address).trim().slice(0, 1).toUpperCase()
const record = (value: unknown) => JSON.stringify(value, null, 2)
// The full record as returned, without repeating the messages shown below it.
const roomRecord = computed(() => { const { messages: _messages, ...rest } = props.room; return record(rest) })

const body = ref<HTMLElement | null>(null)
const unseen = ref<{ id: string; count: number } | null>(null)
let jumpAfterLoad = false
function show(id: string) {
  const target = [...(body.value?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(item => item.dataset.messageId === id)
  target?.scrollIntoView?.({ block: 'start' })
  target?.focus({ preventScroll: true })
}
// A reader who has selected text in the room is reading, not following.
function selecting() {
  const selection = window.getSelection?.()
  return Boolean(selection && !selection.isCollapsed && selection.anchorNode && body.value?.contains(selection.anchorNode))
}
// Measured before the new messages render: was the reader at the end?
watch(() => props.room.messages.length, async (length, previous) => {
  const first = props.room.messages[previous]
  if (!previous || length <= previous || !first) return
  const following = gapToEnd(body.value) <= TAIL_FOLLOW_PX && !selecting()
  const jump = jumpAfterLoad
  jumpAfterLoad = false
  await nextTick()
  if (jump) { unseen.value = null; show(first.messageId) }
  else if (following && !unseen.value) scrollToEnd(body.value)
  else unseen.value = { id: unseen.value?.id ?? first.messageId, count: (unseen.value?.count ?? 0) + length - previous }
})
function jumpToUnseen() {
  const target = unseen.value
  unseen.value = null
  if (target) show(target.id)
}
function later() {
  jumpAfterLoad = Boolean(props.newMessages)
  emit('later')
}
const reachedEnd = () => { if (unseen.value && gapToEnd(body.value) <= TAIL_FOLLOW_PX) unseen.value = null }
onMounted(() => document.addEventListener('scroll', reachedEnd, { capture: true, passive: true }))
onBeforeUnmount(() => document.removeEventListener('scroll', reachedEnd, { capture: true }))
</script>

<template>
  <article class="ui-split-detail" data-testid="roundtable-chat">
    <header class="ui-split-detail-head">
      <slot name="back" />
      <h2 tabindex="-1" class="roundtable-chat-title" data-roundtable-detail-title>{{ chatRoomName(room) }}</h2>
      <p class="ui-list-meta">
        <span>{{ t(`roundtable.chat.kinds.${room.kind}`) }}</span>
        <span>{{ t('roundtable.shownMessages', { count: room.messages.length }) }}</span>
        <span>{{ time(room.createdAt) }}</span>
      </p>
      <details class="roundtable-chat-fold" :open="wide">
        <summary>{{ t('roundtable.participants', { count: seats.length }) }}</summary>
        <RoundtableSeats :seats="seats" />
      </details>
      <details class="roundtable-chat-fold" data-roundtable-record>
        <summary>{{ t('roundtable.recordDetails') }}</summary>
        <pre tabindex="0">{{ roomRecord }}</pre>
      </details>
    </header>
    <div ref="body" class="ui-split-detail-body">
      <ol v-if="room.messages.length" class="roundtable-chat-messages">
        <li v-for="message in room.messages" :key="message.messageId" class="roundtable-chat-message" tabindex="-1"
          :data-message-id="message.messageId" data-roundtable-chat-message>
          <span class="roundtable-chat-avatar" :style="agentIdentityStyle(sender(message.from)?.agentId ?? null)" aria-hidden="true">{{ initial(message.from) }}</span>
          <div class="roundtable-chat-bubble">
            <p class="roundtable-chat-byline">
              <strong>{{ senderName(message.from) }}</strong>
              <time class="ui-meta" :datetime="message.createdAt">{{ time(message.createdAt) }}</time>
            </p>
            <p class="roundtable-chat-body">{{ message.body }}</p>
            <details class="roundtable-chat-fold"><summary>{{ t('roundtable.recordDetails') }}</summary><pre tabindex="0">{{ record(message) }}</pre></details>
          </div>
        </li>
      </ol>
      <p v-else class="ui-meta">{{ t('roundtable.chat.empty') }}</p>
      <p v-if="laterFailed" role="alert" class="inline-error roundtable-chat-more">{{ t('roundtable.loadFailed') }}</p>
      <p v-if="laterStuck" role="status" class="ui-meta roundtable-chat-more" data-roundtable-later-stuck>{{ t('roundtable.laterStuck') }}</p>
      <p v-if="newMessages" role="status" class="roundtable-chat-more" data-roundtable-new-messages>{{ t('roundtable.newMessages') }}</p>
      <Button v-if="room.hasMore || newMessages" class="roundtable-chat-more" size="sm" variant="ghost" :loading="loadingLater"
        :loading-label="t('roundtable.loadingLater')" data-roundtable-later @click="later">
        {{ newMessages ? t('roundtable.loadNewMessages') : t('roundtable.laterMessages') }}</Button>
      <Button variant="outline" v-if="unseen" class="roundtable-chat-jump" size="sm" data-roundtable-jump @click="jumpToUnseen">
        {{ t('roundtable.jumpToNew', { count: unseen.count }) }}</Button>
    </div>
  </article>
</template>

<style scoped>
.roundtable-chat-title { overflow-wrap: anywhere; }
.roundtable-chat-fold summary { cursor: pointer; color: var(--color-muted); font-size: 12px; }
.roundtable-chat-fold pre { overflow: auto; max-height: 240px; margin: 4px 0 0; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.roundtable-chat-messages { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.roundtable-chat-message { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; max-width: 760px; }
.roundtable-chat-avatar { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 50%; color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft)); font-size: 12px; font-weight: 650; }
.roundtable-chat-bubble { min-width: 0; }
.roundtable-chat-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 6px; }
.roundtable-chat-byline strong { font-size: 14px; font-weight: 600; }
.roundtable-chat-body { margin: 0; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 4px 12px 12px 12px; background: var(--color-bg); color: var(--color-ink); font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.roundtable-chat-more { margin-top: 16px; }
.roundtable-chat-jump { position: sticky; bottom: 12px; display: flex; margin: 16px auto 0; }
.roundtable-chat-message:focus { outline: none; }
.roundtable-chat-message:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 4px; border-radius: 8px; }
</style>
