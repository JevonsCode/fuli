<script setup lang="ts">
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import type { RoundtableSeat } from './roundtable-model'

// Who is in the conversation, as one row of chips; anyone still owing a reply is marked.
defineProps<{ seats: RoundtableSeat[] }>()
const initial = (seat: RoundtableSeat) => (seat.person.name ?? '?').trim().slice(0, 1).toUpperCase()
</script>

<template>
  <ul class="roundtable-seats" :aria-label="t('roundtable.table', { count: seats.length })">
    <li v-for="seat in seats" :key="seat.key" class="roundtable-seat" :class="{ 'is-awaited': seat.awaited }" :style="agentIdentityStyle(seat.person.agentId)" data-roundtable-seat>
      <span class="roundtable-seat-face" aria-hidden="true">{{ initial(seat) }}</span>
      <span class="roundtable-seat-name">{{ seat.person.name ?? t('roundtable.unknownAgent') }}</span>
      <small class="roundtable-seat-state">{{ seat.awaited ? t('roundtable.seatAwaited') : t('roundtable.seatSpoke', { count: seat.spoke }) }}</small>
    </li>
  </ul>
</template>

<style scoped>
.roundtable-seats { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.roundtable-seat { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 10px 3px 3px; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-surface); font-size: 12px; }
.roundtable-seat-face { display: grid; flex: 0 0 auto; width: 20px; height: 20px; place-items: center; border-radius: 50%; color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft)); font-size: 11px; font-weight: 650; }
.roundtable-seat-name { min-width: 0; overflow: hidden; color: var(--color-ink); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.roundtable-seat-state { color: var(--color-faint); font-size: 11px; white-space: nowrap; }
.roundtable-seat.is-awaited { border-color: var(--color-warning); }
.roundtable-seat.is-awaited .roundtable-seat-state { color: var(--color-warning); }
</style>
