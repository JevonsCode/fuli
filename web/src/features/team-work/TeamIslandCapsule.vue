<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import TeamFaces from './TeamFaces.vue'
import { currentStepOf, fill, type TeamSheet } from './team-sheets'

// One task in the 悬浮岛: a glass capsule saying who is doing what and how far.
// A click opens its 团队卡片 above the row (TeamIsland.vue); the capsule stays
// where it is and shows that it is the open one.
const props = defineProps<{
  sheet: TeamSheet
  open: boolean
  panelId: string
}>()
const emit = defineEmits<{ toggle: [] }>()
const faces = computed(() => props.sheet.shares.slice(0, 4).map(share => ({
  agentId: share.agentId,
  lead: share.agentId === props.sheet.leadAgentId,
  fill: fill(share.progress),
  working: Boolean(currentStepOf(props.sheet, share)),
})))
const total = computed(() => fill(props.sheet.progress))
</script>

<template>
  <div class="island" :class="{ 'is-open': open }" :data-team-island="sheet.taskId">
    <Button variant="ghost" class="island-head" :aria-expanded="open" :aria-controls="open ? panelId : undefined"
      data-team-island-pill @click="emit('toggle')">
      <TeamFaces :faces="faces" :size="24" />
      <span class="island-label">{{ t('teamWork.island.label', { count: sheet.shares.length, title: sheet.title }) }}</span>
      <template v-if="total !== null">
        <span class="island-bar" aria-hidden="true"><i :style="{ transform: `scaleX(${total})` }" /></span>
        <span class="island-count ui-num">{{ sheet.progress!.completed }}/{{ sheet.progress!.total }}</span>
      </template>
    </Button>
  </div>
</template>

<style scoped>
/* Glass, like the dock: it floats over the page and blurs what scrolls beneath.
   As tall as the fold button beside it (--island-height, TeamIsland.vue); its
   slot in the row sets the width. */
.island {
  display: flex; align-items: center; box-sizing: border-box; width: 100%; height: var(--island-height, 48px); min-width: 0; padding: 4px; border: 1px solid var(--edge-glass); border-radius: 30px;
  background: var(--glass-sheen), var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 10px 30px -10px rgb(var(--shadow-rgb) / 26%);
  transition: border-color var(--motion-fast), box-shadow var(--motion-fast);
}
/* The open one lifts a little and takes the gold edge; it does not move. */
.island.is-open { border-color: var(--color-gold); box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 14px 34px -12px rgb(var(--shadow-rgb) / 32%); }
.island-head {
  display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; height: 100%; min-width: 0; padding: 0 14px 0 6px;
  border-radius: var(--radius-pill); color: var(--color-ink); font-size: var(--text-control); font-weight: var(--weight-regular); text-align: left; white-space: nowrap;
}
.island-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.island-bar { position: relative; flex: none; width: 44px; height: 4px; overflow: hidden; border-radius: 4px; background: var(--color-surface-hover); }
.island-bar i { position: absolute; inset: 0; border-radius: inherit; background: var(--color-gold); transform-origin: left center; transition: transform var(--motion-spring) var(--motion-ease-spring); }
.island-count { flex: none; color: var(--color-muted); font-size: var(--text-meta); }
</style>
