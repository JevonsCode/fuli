<script setup lang="ts">
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'

// The people on one task, overlapping like a group of contacts: the lead a
// little larger, a thin ring around each portrait filled to that share's
// recorded progress (a dashed track when nothing is recorded), and a soft breath on
// whoever is doing a step right now.
defineProps<{
  faces: { agentId: string; lead: boolean; fill: number | null; working: boolean }[]
  size?: number
}>()
const R = 16.5
const C = 2 * Math.PI * R
</script>

<template>
  <span class="team-faces" aria-hidden="true" :style="{ '--face': `${size ?? 36}px` }">
    <span v-for="face in faces" :key="face.agentId" class="team-face" :class="{ 'is-lead': face.lead, 'is-working': face.working }"
      :style="agentIdentityStyle(face.agentId)">
      <img :src="agentAvatarUrl(face.agentId)" alt="" />
      <svg class="team-ring" viewBox="0 0 36 36">
        <circle class="team-ring-track" :class="{ 'is-unrecorded': face.fill === null }" cx="18" cy="18" :r="R" />
        <circle v-if="face.fill !== null" class="team-ring-fill" cx="18" cy="18" :r="R" :stroke-dasharray="C" :stroke-dashoffset="C * (1 - face.fill)" />
      </svg>
    </span>
  </span>
</template>

<style scoped>
.team-faces { display: inline-flex; align-items: center; }
.team-face {
  position: relative; display: grid; flex: none; width: var(--face); height: var(--face); margin-left: -12px;
  place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-surface-hover)); box-shadow: 0 0 0 2px var(--color-surface);
}
.team-face:first-child { margin-left: 0; }
.team-face.is-lead { z-index: 1; width: calc(var(--face) * 1.18); height: calc(var(--face) * 1.18); }
.team-face img { width: calc(100% - 6px); height: calc(100% - 6px); border-radius: 50%; object-fit: cover; }
.team-ring { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); }
.team-ring circle { fill: none; stroke-width: 2; }
.team-ring-track { stroke: var(--color-border); }
.team-ring-track.is-unrecorded { stroke: var(--color-faint); stroke-dasharray: 2 3; }
.team-ring-fill { stroke: var(--color-gold); stroke-linecap: round; transition: stroke-dashoffset var(--motion-spring) var(--motion-ease-spring); }
/* The current step breathes: a slow, soft halo, gone under reduced motion. */
.team-face.is-working { animation: team-breathe var(--motion-pulse) ease-in-out infinite; }
@keyframes team-breathe {
  0%, 100% { box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 2px var(--color-gold-soft); }
  50% { box-shadow: 0 0 0 2px var(--color-surface), 0 0 0 6px var(--color-gold-soft); }
}
</style>
