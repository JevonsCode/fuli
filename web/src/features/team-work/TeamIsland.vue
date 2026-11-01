<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import TeamIslandCapsule from './TeamIslandCapsule.vue'
import { useTeamPeople } from './useTeamPeople'
import { useTeamWork } from './useTeamWork'

// Widget 'team-island' (悬浮岛): while FLAs are doing tasks together, one glass
// capsule per task floats just above the dock on every page. Hovering opens a
// capsule into its 团队卡片 (120 ms in, 260 ms out); a click pins it; Esc or a
// click elsewhere folds it. While one is open the others step aside. No running
// team work, no island.
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const team = useTeamWork(spaceId)
const people = useTeamPeople(spaceId, team.running)

const openId = ref<string | null>(null)
const pinned = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
const root = ref<HTMLElement | null>(null)
function hover(taskId: string | null) {
  clearTimeout(timer)
  if (pinned.value) return
  timer = setTimeout(() => { openId.value = taskId }, taskId ? 120 : 260)
}
function toggle(taskId: string) {
  clearTimeout(timer)
  const closing = openId.value === taskId && pinned.value
  openId.value = closing ? null : taskId
  pinned.value = !closing
}
function close() { clearTimeout(timer); openId.value = null; pinned.value = false }
function outside(event: PointerEvent) { if (root.value && !root.value.contains(event.target as Node)) close() }
watch(openId, (id) => {
  if (id) document.addEventListener('pointerdown', outside)
  else document.removeEventListener('pointerdown', outside)
})
// A task that stops running takes its open capsule with it.
watch(() => team.running.value.map(sheet => sheet.taskId), (ids) => { if (openId.value && !ids.includes(openId.value)) close() })
onBeforeUnmount(() => { clearTimeout(timer); document.removeEventListener('pointerdown', outside) })
</script>

<template>
  <div v-if="team.running.value.length" ref="root" class="team-islands" :class="{ 'has-open': openId }" role="region"
    :aria-label="t('teamWork.island.region')" data-widget="team-island" data-term="work.island" @keydown.esc="close">
    <TeamIslandCapsule v-for="(sheet, index) in team.running.value" :key="sheet.taskId" :sheet="sheet" :open="openId === sheet.taskId" :wide="index === 0"
      :class="{ 'is-aside': openId && openId !== sheet.taskId }" :space-id="spaceId" :name-of="people.nameOf" :project-name="people.projectName"
      @pointerenter="hover(sheet.taskId)" @pointerleave="hover(null)" @toggle="toggle(sheet.taskId)" />
  </div>
</template>

<style scoped>
/* A row of capsules just above the dock, left-aligned with it like the pins. */
.team-islands {
  position: fixed; bottom: calc(20px + 58px + 10px); left: max(var(--page-gutter), calc((100vw - var(--canvas-max)) / 2)); z-index: var(--z-nav);
  display: flex; align-items: flex-end; gap: 10px; max-width: calc(100vw - 2 * var(--page-gutter));
}
/* While one is open the others step aside (gone from the row, not from the page's reading order). */
.team-islands :deep(.island.is-aside) { position: absolute; opacity: 0; pointer-events: none; transform: scale(.94); transition: opacity var(--motion-exit), transform var(--motion-exit); }
@media (max-width: 720px) {
  .team-islands { right: 0; left: 0; flex-direction: column; align-items: center; margin-inline: auto; bottom: calc(12px + 58px + 10px + env(safe-area-inset-bottom)); }
}
</style>
