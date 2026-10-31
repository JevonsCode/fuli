<script setup lang="ts">
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { Button } from '@/components/ui/button'
import type { RoundtableChatPage } from './roundtable-api'
import { chatRunMarks } from './chat-runs'
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
const senderAvatar = (address: string) => {
  const id = sender(address)?.agentId
  return id ? agentAvatarUrl(id) : undefined
}
const initial = (address: string) => senderName(address).trim().slice(0, 1).toUpperCase()
const marks = computed(() => chatRunMarks(props.room.messages.map(message => ({ from: message.from, at: message.createdAt }))))

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
  <article class="rt-chat" data-testid="roundtable-chat">
    <header class="rt-chat-head">
      <span class="rt-chat-faces" aria-hidden="true">
        <span v-for="seat in seats.slice(0, 4)" :key="seat.key" :style="agentIdentityStyle(seat.person.agentId)"><img
          v-if="seat.person.agentId" :src="agentAvatarUrl(seat.person.agentId)" alt="" /><template v-else>{{ (seat.person.name ?? '?').slice(0, 1) }}</template></span>
      </span>
      <h2 tabindex="-1" class="rt-chat-title" data-roundtable-detail-title>{{ chatRoomName(room) }}</h2>
      <p class="rt-chat-meta">{{ t(`roundtable.chat.kinds.${room.kind}`) }} · {{ t('roundtable.shownMessages', { count: room.messages.length }) }} · {{ time(room.createdAt) }}</p>
      <details class="rt-chat-people">
        <summary>{{ t('roundtable.participants', { count: seats.length }) }}</summary>
        <RoundtableSeats :seats="seats" />
      </details>
    </header>
    <div ref="body" class="rt-chat-body">
      <ol v-if="room.messages.length" class="rt-bubbles">
        <li v-for="(message, index) in room.messages" :key="message.messageId" class="rt-msg" :class="{ 'is-run-start': marks[index]!.runStart }" tabindex="-1"
          :data-message-id="message.messageId" data-roundtable-chat-message>
          <p v-if="marks[index]!.separator" class="rt-sep"><time :datetime="message.createdAt">{{ time(message.createdAt) }}</time></p>
          <div class="rt-msg-row">
            <span v-if="marks[index]!.runStart" class="rt-face roundtable-chat-avatar" :style="agentIdentityStyle(sender(message.from)?.agentId ?? null)" aria-hidden="true"><img
              v-if="senderAvatar(message.from)" :src="senderAvatar(message.from)" alt="" /><template v-else>{{ initial(message.from) }}</template></span>
            <span v-else class="rt-face-gap" aria-hidden="true" />
            <div class="rt-msg-col">
              <p v-if="marks[index]!.runStart" class="rt-byline"><strong>{{ senderName(message.from) }}</strong></p>
              <p v-else class="ui-sr-only">{{ senderName(message.from) }}</p>
              <p class="rt-bubble roundtable-chat-body" :title="time(message.createdAt)">{{ message.body }}</p>
            </div>
          </div>
        </li>
      </ol>
      <p v-else class="rt-chat-empty">{{ t('roundtable.chat.empty') }}</p>
      <p v-if="laterFailed" role="alert" class="rt-chat-more rt-status" data-tone="danger">{{ t('roundtable.loadFailed') }}</p>
      <p v-if="laterStuck" role="status" class="rt-chat-more rt-status" data-roundtable-later-stuck>{{ t('roundtable.laterStuck') }}</p>
      <p v-if="newMessages" role="status" class="rt-chat-more rt-status" data-roundtable-new-messages>{{ t('roundtable.newMessages') }}</p>
      <div v-if="room.hasMore || newMessages" class="rt-chat-more">
        <Button size="sm" variant="ghost" :loading="loadingLater" :loading-label="t('roundtable.loadingLater')" data-roundtable-later @click="later">
          {{ newMessages ? t('roundtable.loadNewMessages') : t('roundtable.laterMessages') }}</Button>
      </div>
      <Button v-if="unseen" variant="outline" class="rt-chat-jump" size="sm" data-roundtable-jump @click="jumpToUnseen">
        {{ t('roundtable.jumpToNew', { count: unseen.count }) }}</Button>
    </div>
  </article>
</template>

<style scoped src="./roundtable-chat.css"></style>
<style scoped>
.rt-msg:focus { outline: none; }
.rt-msg:focus-visible .rt-bubble { outline: 2px solid var(--color-focus); outline-offset: 3px; }
</style>
