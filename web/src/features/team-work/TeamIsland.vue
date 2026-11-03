<script setup lang="ts">
import { AnimatePresence, motion } from 'motion-v'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import { UiIcon } from '@/ui'
import { useConsoleStore } from '@/stores/console'
import TeamCard from './TeamCard.vue'
import TeamIslandCapsule from './TeamIslandCapsule.vue'
import TeamOrbit from './TeamOrbit.vue'
import { currentStepOf } from './team-sheets'
import { useTeamPeople } from './useTeamPeople'
import { useTeamWork } from './useTeamWork'

// Widget 'team-island' (悬浮岛): while FLAs are doing tasks together, one glass
// capsule per task floats just above the dock on every page. A click opens that
// task's 团队卡片 above the row, always from its left edge whichever capsule was
// clicked, and the capsules stay where they are (Jevons 11-02: hovering opened
// cards by accident, and a card grew out of whichever capsule it was). Another
// click on the capsule, Esc or a click elsewhere folds it. A round button before
// the row folds the whole row away, showing only how many there are (and, while
// FLAs are working, their tiny portraits circling it: TeamOrbit.vue), and opens
// it again; the choice is remembered on this computer. The button and the
// capsules share one height and one centre line (--island-height), and the
// capsules slide out of and back into the button instead of cutting.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const team = useTeamWork(spaceId)
const people = useTeamPeople(spaceId, team.running)

const FOLDED_KEY = 'fuli.teamIsland.folded'
const folded = ref(readFolded())
function readFolded() { try { return globalThis.localStorage?.getItem(FOLDED_KEY) === '1' } catch { return false } }
function toggleFolded() {
  folded.value = !folded.value
  if (folded.value) openId.value = null
  try {
    if (folded.value) globalThis.localStorage?.setItem(FOLDED_KEY, '1')
    else globalThis.localStorage?.removeItem(FOLDED_KEY)
  } catch { /* the row still folds for this visit */ }
}

const openId = ref<string | null>(null)
const panelId = useId()
// The FLAs working right now across the running tasks, at most six, for the folded button.
const ORBIT_LIMIT = 6
const working = computed(() => [...new Set(team.running.value.flatMap(sheet => sheet.shares
  .filter(share => share.status === 'running' || currentStepOf(sheet, share))
  .map(share => share.agentId)))].slice(0, ORBIT_LIMIT))
// Capsules slide in one after another from the fold button and back into it.
const capsules = computed(() => folded.value ? [] : team.running.value)
const SLIDE_IN = { opacity: 0, x: -14, scale: 0.96 }
const slideOut = (index: number) => ({ ...SLIDE_IN, transition: { duration: 0.16, delay: index * 0.03 } })
const slideIn = (index: number) => ({ opacity: 1, x: 0, scale: 1, transition: { ...SPRING, delay: index * 0.04 } })
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
    <Button variant="ghost" class="island-fold" :aria-expanded="!folded" :aria-label="t(folded ? 'teamWork.island.unfold' : 'teamWork.island.fold', { count: team.running.value.length })"
      data-team-island-fold @click="toggleFolded">
      <AnimatePresence mode="wait" :initial="false">
        <motion.span :key="folded ? 'count' : 'chevron'" class="island-fold-face" :initial="{ opacity: 0, scale: 0.6 }"
          :animate="{ opacity: 1, scale: 1 }" :exit="{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }">
          <TeamOrbit v-if="folded && working.length" :agent-ids="working" :count="team.running.value.length" />
          <span v-else-if="folded" class="island-fold-count ui-num">{{ team.running.value.length }}</span>
          <UiIcon v-else name="chevron-left" :size="16" />
        </motion.span>
      </AnimatePresence>
    </Button>
    <AnimatePresence :initial="false">
      <motion.div v-for="(sheet, index) in capsules" :key="sheet.taskId" class="island-slot" :class="{ 'is-wide': index === 0 }"
        :initial="SLIDE_IN" :animate="slideIn(index)" :exit="slideOut(index)">
        <TeamIslandCapsule :sheet="sheet" :open="openId === sheet.taskId" :panel-id="panelId"
          @toggle="toggle(sheet.taskId)" />
      </motion.div>
    </AnimatePresence>
  </div>
</template>

<style scoped>
/* A row of capsules just above the dock, left-aligned with it like the pins. */
.team-islands {
  position: fixed; bottom: calc(20px + 58px + 10px); left: var(--float-inline); z-index: var(--z-nav);
  /* One height for the fold button and every capsule, centred on one line (Jevons 11-03). */
  --island-height: 48px;
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 2 * var(--page-gutter));
}
.island-slot { flex: 0 1 330px; min-width: 0; transform-origin: left center; }
.island-slot.is-wide { flex-basis: 440px; }
/* The open card sits above the row, from its left edge, in the island's glass. */
.island-card {
  position: absolute; bottom: calc(100% + 10px); left: 0; width: min(620px, calc(100vw - 2 * var(--page-gutter))); padding: 4px;
  border: 1px solid var(--edge-glass); border-radius: 26px; background: var(--glass-sheen), var(--surface-dock-panel);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 24px 60px -12px rgb(var(--shadow-rgb) / 30%);
}
/* The fold button: a glass circle exactly as tall as a capsule; folded, it says how many tasks wait behind it. */
.island-fold {
  display: grid; flex: none; width: var(--island-height); height: var(--island-height); place-items: center; padding: 0; border: 1px solid var(--edge-glass); border-radius: 50%;
  color: var(--color-ink-soft); background: var(--glass-sheen), var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 10px 30px -10px rgb(var(--shadow-rgb) / 26%); cursor: pointer; user-select: none;
  transition: transform var(--motion-fast);
}
.island-fold:hover { transform: translateY(-1px); }
.island-fold:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.island-fold-face { display: grid; width: 100%; height: 100%; place-items: center; }
.island-fold-count { font-size: var(--text-control); font-weight: var(--weight-medium); }
.island-card :deep(.team-card) { max-height: min(60vh, 520px); overflow-y: auto; box-shadow: none; }
@media (max-width: 720px) {
  .team-islands { right: 0; left: 0; flex-direction: column; align-items: center; margin-inline: auto; bottom: calc(12px + 58px + 10px + env(safe-area-inset-bottom)); }
  /* In a column flex-basis is a height: the wide slot's 440px basis made the first capsule 440px tall. */
  .island-slot, .island-slot.is-wide { flex: none; width: min(330px, 100%); }
  .island-slot.is-wide { width: min(440px, 100%); }
  .island-card { left: 50%; translate: -50% 0; }
}
</style>
