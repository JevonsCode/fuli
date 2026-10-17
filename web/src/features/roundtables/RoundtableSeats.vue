<script setup lang="ts">
import { computed } from 'vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { seatPosition, type RoundtableSeat } from './roundtable-model'

// The table itself: one seat per participant, spaced evenly whatever the count.
const props = defineProps<{ seats: RoundtableSeat[] }>()
const size = computed(() => Math.min(360, 180 + props.seats.length * 18))
const initial = (seat: RoundtableSeat) => (seat.person.name ?? '?').trim().slice(0, 1).toUpperCase()
</script>

<template>
  <figure class="roundtable-table" :style="{ width: `${size}px` }" :aria-label="t('roundtable.table', { count: seats.length })">
    <div class="roundtable-table-top" aria-hidden="true" />
    <div v-for="(seat, index) in seats" :key="seat.key" class="roundtable-seat" :class="{ 'is-awaited': seat.awaited }"
      :style="{ ...seatPosition(index, seats.length), ...agentIdentityStyle(seat.person.agentId) }" data-roundtable-seat>
      <span class="roundtable-seat-face" aria-hidden="true">{{ initial(seat) }}</span>
      <span class="roundtable-seat-name">{{ seat.person.name ?? t('roundtable.unknownAgent') }}</span>
      <small class="roundtable-seat-state">{{ seat.awaited ? t('roundtable.seatAwaited') : t('roundtable.seatSpoke', { count: seat.spoke }) }}</small>
    </div>
  </figure>
</template>

<style scoped>
.roundtable-table { position: relative; aspect-ratio: 1; max-width: 100%; margin: 8px auto 4px; }
.roundtable-table-top { position: absolute; inset: 22%; border: 1px solid var(--color-border); border-radius: 50%; background: radial-gradient(circle at 50% 40%, var(--color-surface), var(--color-bg)); }
.roundtable-seat { position: absolute; display: grid; justify-items: center; gap: 2px; width: 84px; transform: translate(-50%, -50%); text-align: center; }
.roundtable-seat-face { display: grid; width: 36px; height: 36px; place-items: center; border: 2px solid var(--color-surface); border-radius: 50%; color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft)); font-weight: 650; }
.roundtable-seat.is-awaited .roundtable-seat-face { box-shadow: 0 0 0 2px var(--color-warning); }
.roundtable-seat-name { max-width: 100%; overflow: hidden; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.roundtable-seat-state { color: var(--color-muted); font-size: 11px; }
.roundtable-seat.is-awaited .roundtable-seat-state { color: var(--color-warning); }
</style>
