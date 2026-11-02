<script setup lang="ts">
import { AnimatePresence, motion } from 'motion-v'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import { useConsoleStore } from '@/stores/console'
import TeamCard from './TeamCard.vue'
import TeamIslandCapsule from './TeamIslandCapsule.vue'
import { useTeamPeople } from './useTeamPeople'
import { useTeamWork } from './useTeamWork'

// Widget 'team-island' (悬浮岛): while FLAs are doing tasks together, one glass
// capsule per task floats just above the dock on every page. A click opens that
// task's 团队卡片 above the row, always from its left edge whichever capsule was
// clicked, and the capsules stay where they are (Jevons 11-02: hovering opened
// cards by accident, and a card grew out of whichever capsule it was). Another
// click on the capsule, Esc or a click elsewhere folds it.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const team = useTeamWork(spaceId)
const people = useTeamPeople(spaceId, team.running)

const openId = ref<string | null>(null)
const panelId = useId()
const root = ref<HTMLElement | null>(null)
const openSheet = computed(() => team.running.value.find(sheet => sheet.taskId === openId.value) ?? null)
function toggle(taskId: string) { openId.value = openId.value === taskId ? null : taskId }
function close() { openId.value = null }
function outside(event: PointerEvent) { if (root.value && !root.value.contains(event.target as Node)) close() }
watch(openId, (id) => {
  if (id) document.addEventListener('pointerdown', outside)
  else document.removeEventListener('pointerdown', outside)
})
// A task that stops running takes its open card with it.
watch(() => team.running.value.map(sheet => sheet.taskId), (ids) => { if (openId.value && !ids.includes(openId.value)) close() })
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div v-if="team.running.value.length" ref="root" class="team-islands" role="region"
    :aria-label="t('teamWork.island.region')" data-widget="team-island" data-term="work.island" @keydown.esc="close">
    <AnimatePresence>
      <motion.div v-if="openSheet" :id="panelId" :key="openSheet.taskId" class="island-card" :initial="{ opacity: 0, y: 8 }"
        :animate="{ opacity: 1, y: 0 }" :exit="{ opacity: 0, y: 8 }" :transition="SPRING">
        <TeamCard :sheet="openSheet" :space-id="spaceId" :name-of="people.nameOf" :project-name="people.projectName" default-open />
      </motion.div>
    </AnimatePresence>
    <TeamIslandCapsule v-for="(sheet, index) in team.running.value" :key="sheet.taskId" :sheet="sheet" :open="openId === sheet.taskId"
      :wide="index === 0" :panel-id="panelId" @toggle="toggle(sheet.taskId)" />
  </div>
</template>

<style scoped>
/* A row of capsules just above the dock, left-aligned with it like the pins. */
.team-islands {
  position: fixed; bottom: calc(20px + 58px + 10px); left: var(--page-inline); z-index: var(--z-nav);
  display: flex; align-items: flex-end; gap: 10px; max-width: calc(100vw - 2 * var(--page-gutter));
}
/* The open card sits above the row, from its left edge, in the island's glass. */
.island-card {
  position: absolute; bottom: calc(100% + 10px); left: 0; width: min(620px, calc(100vw - 2 * var(--page-gutter))); padding: 4px;
  border: 1px solid var(--edge-glass); border-radius: 26px; background: var(--surface-glass-strong);
  -webkit-backdrop-filter: blur(24px) saturate(160%); backdrop-filter: blur(24px) saturate(160%);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 24px 60px -12px rgb(var(--shadow-rgb) / 30%);
}
.island-card :deep(.team-card) { max-height: min(60vh, 520px); overflow-y: auto; box-shadow: none; }
@media (max-width: 720px) {
  .team-islands { right: 0; left: 0; flex-direction: column; align-items: center; margin-inline: auto; bottom: calc(12px + 58px + 10px + env(safe-area-inset-bottom)); }
  .island-card { left: 50%; translate: -50% 0; }
}
</style>
