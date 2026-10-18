<script setup lang="ts">
import { computed } from 'vue'
import { loopPhaseDelay } from '@/lib/motion-phase'

export type AvatarStatus = 'working' | 'waiting' | 'idle' | 'error' | 'none'

// One avatar for every Agent surface. The status ring is drawn outside the
// avatar box with its own layer, so no container can clip it, and looping
// rings are phase-locked to a shared clock so re-renders never restart them.
const props = withDefaults(defineProps<{
  name: string
  image?: string | null
  color?: string | null
  softColor?: string | null
  status?: AvatarStatus
  size?: 'sm' | 'md' | 'lg'
}>(), { image: null, color: null, softColor: null, status: 'none', size: 'md' })

const PERIOD = { working: 2400, waiting: 1400 } as const
const initial = computed(() => [...props.name.trim()][0]?.toUpperCase() ?? '?')
const style = computed(() => ({
  ...(props.color ? { '--avatar-color': props.color } : {}),
  ...(props.softColor ? { '--avatar-soft': props.softColor } : {}),
  ...(props.status === 'working' || props.status === 'waiting'
    ? { '--avatar-phase': loopPhaseDelay(PERIOD[props.status]) } : {}),
}))
</script>

<template>
  <span class="ui-avatar" :class="[`is-${size}`, `is-${status}`]" :style="style" :data-status="status"
    :data-term="status === 'none' ? undefined : `presence.${status}`">
    <img v-if="image" :src="image" alt="" />
    <span v-else aria-hidden="true">{{ initial }}</span>
  </span>
</template>

<style scoped>
.ui-avatar {
  --avatar-color: var(--color-accent);
  --avatar-soft: var(--color-accent-soft);
  position: relative; display: inline-grid; flex: 0 0 auto; place-items: center;
  border-radius: 30%; color: var(--avatar-color); background: var(--avatar-soft);
  font-weight: 700; line-height: 1;
}
.ui-avatar.is-sm { width: 28px; height: 28px; font-size: 13px; }
.ui-avatar.is-md { width: 40px; height: 40px; font-size: 18px; }
.ui-avatar.is-lg { width: 72px; height: 72px; font-size: 32px; }
.ui-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }
/* The ring sits outside the box; status colour comes from the shared tokens. */
.ui-avatar::after {
  content: ''; position: absolute; inset: -4px; border: 2px solid transparent; border-radius: 34%;
  pointer-events: none; will-change: transform, opacity;
}
.ui-avatar.is-working::after {
  border-color: var(--status-working);
  animation: ui-avatar-pulse var(--motion-pulse) ease-out var(--avatar-phase, 0ms) infinite;
}
.ui-avatar.is-waiting::after {
  border-color: var(--status-waiting);
  animation: ui-avatar-blink var(--motion-blink) ease-in-out var(--avatar-phase, 0ms) infinite;
}
.ui-avatar.is-error::after { border-color: var(--status-error); }
.ui-avatar.is-idle::after { border-color: var(--color-border-strong); }
@keyframes ui-avatar-pulse { 0% { opacity: .7; transform: scale(.94); } 100% { opacity: 0; transform: scale(1.18); } }
@keyframes ui-avatar-blink { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ui-avatar::after { animation: none !important; opacity: 1; } }
:root[data-motion="reduced"] .ui-avatar::after { animation: none !important; opacity: 1; }
</style>
