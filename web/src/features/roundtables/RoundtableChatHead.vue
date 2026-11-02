<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import RoundtableSeats from './RoundtableSeats.vue'
import { isPerson, type RoundtableSeat } from './roundtable-model'

// An open conversation's head in one line (Jevons 11-02): its portraits, its
// title and when it started; everything else — the full title, who is in it,
// a stale read — opens in 详情.
// The portraits are the others at the table, as in Messages; 「我」 is listed in 详情.
const props = defineProps<{ seats: RoundtableSeat[]; title: string; meta: string; stale?: boolean }>()
const faces = computed(() => props.seats.filter(seat => !isPerson(seat.person)).slice(0, 4))
const open = ref(false)
</script>

<template>
  <header class="rt-chat-head">
    <span class="rt-chat-faces" aria-hidden="true">
      <span v-for="seat in faces" :key="seat.key" :style="agentIdentityStyle(seat.person.agentId)"><img
        v-if="seat.person.agentId" :src="agentAvatarUrl(seat.person.agentId)" :data-agent-portrait="seat.person.agentId" alt="" /><template v-else>{{ (seat.person.name ?? '?').slice(0, 1) }}</template></span>
    </span>
    <h2 tabindex="-1" class="rt-chat-title" :title="title" data-roundtable-detail-title>{{ title }}</h2>
    <p class="rt-chat-meta">{{ meta }}</p>
    <span v-if="stale" class="rt-chat-stale" role="status" :title="t('roundtable.stale')" />
    <Button size="sm" variant="ghost" class="rt-chat-more" data-roundtable-details @click="open = true">{{ t('roundtable.details') }}</Button>
    <Dialog :open="open" @update:open="open = $event">
      <DialogContent size="md" data-roundtable-details-dialog>
        <DialogHeader>
          <DialogTitle class="[overflow-wrap:anywhere]">{{ title }}</DialogTitle>
          <DialogDescription>{{ meta }}</DialogDescription>
        </DialogHeader>
        <p v-if="stale" class="rt-chat-meta" role="status">{{ t('roundtable.stale') }}</p>
        <h3 class="rt-chat-people-label">{{ t('roundtable.participants', { count: seats.length }) }}</h3>
        <RoundtableSeats :seats="seats" />
      </DialogContent>
    </Dialog>
  </header>
</template>

<style scoped>
.rt-chat-head {
  display: flex; flex: 0 0 auto; align-items: center; gap: 10px; min-width: 0; padding: 10px 16px 10px 20px;
  border-bottom: 1px solid var(--color-border);
}
.rt-chat-faces { display: flex; flex: none; }
.rt-chat-faces > span {
  display: grid; width: 24px; height: 24px; overflow: hidden; place-items: center; margin-left: -6px; border-radius: 50%;
  color: var(--color-ink-soft); background: var(--agent-identity-soft, var(--color-surface-hover)); box-shadow: 0 0 0 2px var(--color-surface);
  font-size: 11px; font-weight: var(--weight-strong);
}
.rt-chat-faces > span:first-child { margin-left: 0; }
.rt-chat-faces img { width: 100%; height: 100%; object-fit: cover; }
.rt-chat-title {
  flex: 0 1 auto; min-width: 0; margin: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-strong);
  text-overflow: ellipsis; white-space: nowrap;
}
.rt-chat-title:focus { outline: none; }
.rt-chat-title:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 4px; border-radius: 4px; }
.rt-chat-meta { flex: none; margin: 0; color: var(--color-faint); font-size: var(--text-meta); font-variant-numeric: tabular-nums; white-space: nowrap; }
.rt-chat-stale { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning); }
.rt-chat-more { flex: none; margin-left: auto; }
.rt-chat-people-label { margin: 8px 0 0; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
@media (max-width: 480px) { .rt-chat-meta { display: none; } }
</style>
