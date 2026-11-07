<script setup lang="ts">
import AgentAvatar from '@/features/agent-profile/AgentAvatar.vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'

// The folded 悬浮岛 (TeamIsland.vue): the FLAs working right now ride the round
// button's edge as one small overlapping stack, hanging half outside the border
// and turning along it, always upright, with how many tasks wait in the middle
// (Jevons 11-03). The ring turns with a compositor-only transform; reduced
// motion stops it where it is.
const props = defineProps<{ agentIds: string[]; count: number }>()
// Each next portrait sits a little further round the ring, so they overlap like a stack.
const STACK_STEP_DEG = 16
const placed = (index: number) => ({ '--turn': `${index * STACK_STEP_DEG}deg`, zIndex: props.agentIds.length - index })
</script>

<template>
  <span class="team-orbit" aria-hidden="true" data-team-orbit>
    <span class="team-orbit-ring">
      <span v-for="(agentId, index) in agentIds" :key="agentId" class="team-orbit-seat" :style="placed(index)">
        <span class="team-orbit-face" :style="agentIdentityStyle(agentId)">
          <AgentAvatar :agent-id="agentId" />
        </span>
      </span>
    </span>
    <span class="team-orbit-count ui-num">{{ count }}</span>
  </span>
</template>

<style scoped>
.team-orbit { --orbit-face: 13px; position: relative; display: grid; width: 100%; height: 100%; place-items: center; }
.team-orbit-ring { position: absolute; inset: 0; animation: team-orbit-turn 9s linear infinite; }
/* Each seat sits on the button's border (half the island height out from the centre),
   so its portrait hangs half outside; the face turns back so it stays upright. */
.team-orbit-seat {
  position: absolute; top: 50%; left: 50%; width: 0; height: 0;
  transform: rotate(var(--turn)) translateY(calc(var(--island-height, 48px) / -2));
}
.team-orbit-face {
  position: absolute; top: calc(var(--orbit-face) / -2); left: calc(var(--orbit-face) / -2); display: grid;
  width: var(--orbit-face); height: var(--orbit-face); place-items: center; border-radius: 50%;
  background: var(--agent-identity-soft, var(--color-surface-hover)); box-shadow: 0 0 0 1.5px var(--color-surface);
  transform: rotate(calc(-1 * var(--turn))); animation: team-orbit-upright 9s linear infinite;
}
.team-orbit-face img { width: calc(var(--orbit-face) - 2px); height: calc(var(--orbit-face) - 2px); border-radius: 50%; object-fit: cover; }
.team-orbit-count { position: relative; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
@keyframes team-orbit-turn { to { transform: rotate(360deg); } }
@keyframes team-orbit-upright {
  from { transform: rotate(calc(-1 * var(--turn))); }
  to { transform: rotate(calc(-1 * var(--turn) - 360deg)); }
}
</style>
