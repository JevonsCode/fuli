<script setup lang="ts">
import { motion } from 'motion-v'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import { useConsoleStore } from '@/stores/console'
import { UiIcon } from '@/ui'
import TeamCard from './TeamCard.vue'
import TeamFaces from './TeamFaces.vue'
import { currentStep, fill } from './team-sheets'
import { useTeamPeople } from './useTeamPeople'
import { useTeamWork } from './useTeamWork'

// Widget 'team-island' (悬浮岛): a glass capsule that floats just above the
// dock on every page while FLAs are doing a task together. It says who and
// what at a glance; hovering or clicking grows it upward into that task's
// 团队卡片, and it folds back without leaving the page. Several tasks: a count
// and switching inside. It is never in the way: no running team work, no island.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const team = useTeamWork(spaceId)
const people = useTeamPeople(spaceId, team.running)
const panelId = useId()

const index = ref(0)
watch(() => team.running.value.length, (length) => { if (index.value >= length) index.value = Math.max(0, length - 1) })
const sheet = computed(() => team.running.value[index.value] ?? null)
const faces = computed(() => (sheet.value?.shares ?? []).slice(0, 4).map(share => ({
  agentId: share.agentId,
  lead: share.agentId === sheet.value!.leadAgentId,
  fill: fill(share.progress),
  working: Boolean(currentStep(sheet.value!, share.agentId)),
})))
const total = computed(() => (sheet.value ? fill(sheet.value.progress) : null))

// Open by hover (with a short intent delay) or pinned by a click; Esc or a click elsewhere folds it.
const open = ref(false)
const pinned = ref(false)
let hoverTimer: ReturnType<typeof setTimeout> | undefined
const root = ref<HTMLElement | null>(null)
function hover(entering: boolean) {
  clearTimeout(hoverTimer)
  if (pinned.value) return
  hoverTimer = setTimeout(() => { open.value = entering }, entering ? 150 : 320)
}
function toggle() {
  clearTimeout(hoverTimer)
  pinned.value = !(open.value && pinned.value)
  open.value = pinned.value
}
function close() { clearTimeout(hoverTimer); open.value = false; pinned.value = false }
function outside(event: PointerEvent) { if (open.value && root.value && !root.value.contains(event.target as Node)) close() }
watch(open, (value) => {
  if (value) document.addEventListener('pointerdown', outside)
  else document.removeEventListener('pointerdown', outside)
})
watch(() => team.running.value.length, (length) => { if (!length) close() })
onBeforeUnmount(() => { clearTimeout(hoverTimer); document.removeEventListener('pointerdown', outside) })
function step(by: number) {
  const length = team.running.value.length
  index.value = (index.value + by + length) % length
}
</script>

<template>
  <motion.div v-if="sheet" ref="root" layout class="team-island" :class="{ 'is-open': open }" :transition="SPRING" data-widget="team-island" data-term="work.island"
    role="region" :aria-label="t('teamWork.island.region')" @pointerenter="hover(true)" @pointerleave="hover(false)" @keydown.esc="close">
    <div v-if="open" :id="panelId" class="team-island-panel">
      <header class="team-island-bar">
        <span class="team-island-heading">{{ t('teamWork.cards.title') }}<template v-if="team.running.value.length > 1"> · <span class="ui-num">{{ index + 1 }}/{{ team.running.value.length }}</span></template></span>
        <template v-if="team.running.value.length > 1">
          <button type="button" class="team-island-icon" :aria-label="t('teamWork.island.previous')" @click="step(-1)"><UiIcon name="chevron-left" :size="16" /></button>
          <button type="button" class="team-island-icon" :aria-label="t('teamWork.island.next')" @click="step(1)"><UiIcon name="chevron-right" :size="16" /></button>
        </template>
        <button type="button" class="team-island-icon" :aria-label="t('teamWork.island.close')" @click="close"><UiIcon name="chevron-down" :size="16" /></button>
      </header>
      <TeamCard :key="sheet.taskId" :sheet="sheet" :space-id="spaceId" :name-of="people.nameOf" :project-name="people.projectName" default-open />
    </div>
    <button type="button" class="team-island-pill" :aria-expanded="open" :aria-controls="panelId" data-team-island-pill @click="toggle">
      <TeamFaces :faces="faces" :size="24" />
      <span class="team-island-label">{{ t('teamWork.island.label', { count: sheet.shares.length, title: sheet.title }) }}</span>
      <template v-if="total !== null">
        <span class="team-island-bar-mini" aria-hidden="true"><i :style="{ transform: `scaleX(${total})` }" /></span>
        <span class="team-island-count ui-num">{{ sheet.progress!.completed }}/{{ sheet.progress!.total }}</span>
      </template>
      <span v-if="team.running.value.length > 1" class="team-island-more">{{ t('teamWork.island.more', { count: team.running.value.length - 1 }) }}</span>
    </button>
  </motion.div>
</template>

<style scoped>
/* Floats just above the dock, left-aligned with it like the pins capsule. */
.team-island {
  position: fixed; bottom: calc(20px + 58px + 10px); left: max(var(--page-gutter), calc((100vw - var(--canvas-max)) / 2)); z-index: var(--z-nav);
  display: flex; flex-direction: column; gap: 8px; max-width: min(520px, calc(100vw - 2 * var(--page-gutter)));
  padding: 4px; border: 1px solid var(--edge-glass); border-radius: 24px;
  background: var(--surface-glass-strong); backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 10%), 0 10px 30px -10px rgb(var(--shadow-rgb) / 28%);
}
.team-island.is-open { width: min(520px, calc(100vw - 2 * var(--page-gutter))); padding: 8px; }
.team-island-pill {
  display: flex; align-items: center; gap: 10px; min-width: 0; padding: 4px 14px 4px 6px; border: 0; border-radius: var(--radius-pill);
  color: var(--color-ink); background: none; font: inherit; font-size: var(--text-control); text-align: left; cursor: pointer;
}
.team-island-pill:focus-visible, .team-island-icon:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.team-island-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.team-island-bar-mini { position: relative; flex: none; width: 44px; height: 4px; overflow: hidden; border-radius: 4px; background: var(--color-surface-hover); }
.team-island-bar-mini i { position: absolute; inset: 0; border-radius: inherit; background: var(--color-gold); transform-origin: left center; transition: transform var(--motion-spring) var(--motion-ease-spring); }
.team-island-count, .team-island-more { flex: none; color: var(--color-muted); font-size: var(--text-meta); }
.team-island-panel { display: grid; gap: 6px; }
.team-island-bar { display: flex; align-items: center; gap: 4px; padding: 2px 4px 0 10px; }
.team-island-heading { margin-right: auto; color: var(--color-ink-soft); font-size: var(--text-meta); font-weight: var(--weight-strong); }
.team-island-icon { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 50%; color: var(--color-muted); background: none; cursor: pointer; }
.team-island-icon:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.team-island-panel :deep(.team-card) { max-height: min(60vh, 520px); overflow-y: auto; }
@media (max-width: 720px) {
  /* Centred like the phone dock; margins, not a transform, so the morph animation owns transform. */
  .team-island { right: 0; left: 0; width: fit-content; margin-inline: auto; bottom: calc(12px + 58px + 10px + env(safe-area-inset-bottom)); }
  .team-island.is-open { width: calc(100vw - 2 * var(--page-gutter)); }
}
</style>
