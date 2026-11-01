<script setup lang="ts">
import { motion } from 'motion-v'
import { computed, useId } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import { UiIconButton } from '@/ui'
import TeamCard from './TeamCard.vue'
import TeamFaces from './TeamFaces.vue'
import { currentStepOf, fill, type TeamSheet } from './team-sheets'

// One task in the 悬浮岛: folded, a glass capsule saying who is doing what and
// how far; open, the same capsule grown into that task's 团队卡片 (a layout
// morph on the shared spring, interruptible).
const props = defineProps<{
  sheet: TeamSheet
  open: boolean
  wide: boolean
  spaceId: string
  nameOf: (agentId: string) => string
  projectName: (projectId: string) => string
}>()
const emit = defineEmits<{ toggle: [] }>()
const panelId = useId()
const faces = computed(() => props.sheet.shares.slice(0, 4).map(share => ({
  agentId: share.agentId,
  lead: share.agentId === props.sheet.leadAgentId,
  fill: fill(share.progress),
  working: Boolean(currentStepOf(props.sheet, share)),
})))
const total = computed(() => fill(props.sheet.progress))
</script>

<template>
  <motion.div layout class="island" :class="{ 'is-open': open, 'is-wide': wide }" :transition="SPRING" :data-team-island="sheet.taskId">
    <Button v-if="!open" variant="ghost" class="island-head" :aria-expanded="false" :aria-controls="panelId" data-team-island-pill @click="emit('toggle')">
      <TeamFaces :faces="faces" :size="24" />
      <span class="island-label">{{ t('teamWork.island.label', { count: sheet.shares.length, title: sheet.title }) }}</span>
      <template v-if="total !== null">
        <span class="island-bar" aria-hidden="true"><i :style="{ transform: `scaleX(${total})` }" /></span>
        <span class="island-count ui-num">{{ sheet.progress!.completed }}/{{ sheet.progress!.total }}</span>
      </template>
    </Button>
    <!-- Open, the capsule is the card itself; the title is said once, by the card. -->
    <div v-else :id="panelId" class="island-panel">
      <UiIconButton class="island-fold" icon="chevron-down" size="sm" :label="t('teamWork.island.fold')" data-team-island-fold @click="emit('toggle')" />
      <TeamCard :sheet="sheet" :space-id="spaceId" :name-of="nameOf" :project-name="projectName" default-open />
    </div>
  </motion.div>
</template>

<style scoped>
/* Glass, like the dock: it floats over the page and blurs what scrolls beneath. */
.island {
  width: min(var(--island-width, 330px), 100%); min-width: 0; padding: 4px; border: 1px solid var(--edge-glass); border-radius: 30px;
  background: var(--surface-glass-strong); -webkit-backdrop-filter: blur(24px) saturate(160%); backdrop-filter: blur(24px) saturate(160%);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 10px 30px -10px rgb(var(--shadow-rgb) / 26%);
}
.island.is-wide { --island-width: 440px; }
.island.is-open { width: min(620px, 100%); border-radius: 26px; box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 24px 60px -12px rgb(var(--shadow-rgb) / 30%); }
.island-head {
  display: flex; justify-content: flex-start; gap: 10px; width: 100%; height: auto; min-width: 0; padding: 4px 14px 4px 6px;
  border-radius: var(--radius-pill); color: var(--color-ink); font-size: var(--text-control); font-weight: var(--weight-regular); text-align: left; white-space: nowrap;
}
.island-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.island-bar { position: relative; flex: none; width: 44px; height: 4px; overflow: hidden; border-radius: 4px; background: var(--color-surface-hover); }
.island-bar i { position: absolute; inset: 0; border-radius: inherit; background: var(--color-gold); transform-origin: left center; transition: transform var(--motion-spring) var(--motion-ease-spring); }
.island-count { flex: none; color: var(--color-muted); font-size: var(--text-meta); }
.island-panel { position: relative; padding: 4px; }
.island-fold { position: absolute; top: -4px; right: -4px; z-index: 1; background: var(--surface-glass-strong); box-shadow: var(--shadow-sm); }
.island-panel :deep(.team-card) { max-height: min(60vh, 520px); overflow-y: auto; box-shadow: none; }
</style>
