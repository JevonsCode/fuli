<script setup lang="ts">
import { computed } from 'vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import type { RoundtableChatPage } from './roundtable-api'
import { chatRoomName } from './roundtable-model'
import RoundtableSeats from './RoundtableSeats.vue'

// One Agent chat room, read-only: who is in it and what they said, in order.
const props = defineProps<{ room: RoundtableChatPage; time: (value: string) => string }>()
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
</script>

<template>
  <article class="ui-split-detail" data-testid="roundtable-chat">
    <header class="ui-split-detail-head">
      <h2>{{ chatRoomName(room) }}</h2>
      <p class="ui-list-meta">
        <span>{{ t(`roundtable.chat.kinds.${room.kind}`) }}</span>
        <span>{{ t('roundtable.messages', { count: room.messages.length }) }}</span>
        <span>{{ time(room.createdAt) }}</span>
      </p>
      <RoundtableSeats :seats="seats" />
    </header>
    <div class="ui-split-detail-body">
      <ol v-if="room.messages.length" class="roundtable-chat-messages">
        <li v-for="message in room.messages" :key="message.messageId" class="roundtable-chat-message" data-roundtable-chat-message>
          <span class="roundtable-chat-avatar" :style="agentIdentityStyle(sender(message.from)?.agentId ?? null)" aria-hidden="true">{{ initial(message.from) }}</span>
          <div class="roundtable-chat-bubble">
            <p class="roundtable-chat-byline">
              <strong>{{ senderName(message.from) }}</strong>
              <time class="ui-meta" :datetime="message.createdAt">{{ time(message.createdAt) }}</time>
            </p>
            <p class="roundtable-chat-body">{{ message.body }}</p>
          </div>
        </li>
      </ol>
      <p v-else class="ui-meta">{{ t('roundtable.chat.empty') }}</p>
      <p v-if="room.hasMore" class="ui-meta roundtable-chat-more">{{ t('roundtable.chat.more') }}</p>
    </div>
  </article>
</template>

<style scoped>
.roundtable-chat-messages { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.roundtable-chat-message { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; max-width: 760px; }
.roundtable-chat-avatar { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 50%; color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft)); font-size: 12px; font-weight: 650; }
.roundtable-chat-bubble { min-width: 0; }
.roundtable-chat-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 6px; }
.roundtable-chat-byline strong { font-size: 14px; font-weight: 600; }
.roundtable-chat-body { margin: 0; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 4px 12px 12px 12px; background: var(--color-bg); color: var(--color-ink); font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.roundtable-chat-more { margin-top: 16px; }
</style>
