<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle, DialogTrigger, VisuallyHidden } from 'reka-ui'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import TeamCard from './TeamCard.vue'
import TeamOrbit from './TeamOrbit.vue'
import type { TeamSheet } from './team-sheets'

// The 悬浮岛 on a narrow screen (Jevons 11-03): no capsules over the page, only
// a round button beside the dock, which then moves left so the two sit centred
// together. A tap pulls the shared tasks up in a sheet from the bottom.
const props = defineProps<{
  sheets: TeamSheet[]
  working: string[]
  spaceId: string
  nameOf: (agentId: string) => string
  projectName: (projectId: string) => string
}>()

// The dock's own width places the button right beside it (AppDock.vue reads the flag).
const DOCKED = 'data-island-docked'
const dock = ref<HTMLElement | null>(null)
onMounted(() => {
  document.documentElement.setAttribute(DOCKED, '')
  dock.value = document.querySelector('.app-dock')
})
onBeforeUnmount(() => {
  document.documentElement.removeAttribute(DOCKED)
  document.documentElement.style.removeProperty('--dock-width')
})
useResizeObserver(dock, ([entry]) => {
  if (entry) document.documentElement.style.setProperty('--dock-width', `${Math.round(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width)}px`)
})
</script>

<template>
  <DialogRoot>
    <DialogTrigger as-child>
      <Button variant="ghost" class="island-docked" :aria-label="t('teamWork.island.unfold', { count: props.sheets.length })"
        data-team-island-docked>
        <TeamOrbit v-if="props.working.length" :agent-ids="props.working" :count="props.sheets.length" />
        <span v-else class="island-docked-count ui-num">{{ props.sheets.length }}</span>
      </Button>
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="island-sheet-overlay" />
      <DialogContent class="island-sheet" data-team-island-sheet :aria-describedby="undefined">
        <VisuallyHidden><DialogTitle>{{ t('teamWork.island.region') }}</DialogTitle></VisuallyHidden>
        <span class="island-sheet-grip" aria-hidden="true" />
        <div class="island-sheet-list">
          <TeamCard v-for="(sheet, index) in props.sheets" :key="sheet.taskId" :sheet="sheet" :space-id="props.spaceId"
            :name-of="props.nameOf" :project-name="props.projectName" :default-open="index === 0" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
/* Beside the dock and on its centre line: the dock is 58px tall, the button 48px. */
.island-docked {
  position: fixed; z-index: var(--z-nav); bottom: calc(12px + 5px + env(safe-area-inset-bottom));
  left: calc(50% - 29px + var(--dock-width, 250px) / 2 + 10px);
  display: grid; width: 48px; height: 48px; place-items: center; padding: 0; border: 1px solid var(--edge-glass); border-radius: 50%;
  color: var(--color-ink-soft); background: var(--glass-sheen), var(--surface-dock); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: 0 0 0 .5px rgb(var(--shadow-rgb) / 8%), 0 10px 30px -10px rgb(var(--shadow-rgb) / 26%); user-select: none;
}
.island-docked:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.island-docked-count { font-size: var(--text-control); font-weight: var(--weight-medium); }
</style>

<!-- The sheet is teleported to <body>, outside this component's scope. -->
<style>
.island-sheet-overlay { position: fixed; inset: 0; z-index: var(--z-dialog); background: var(--color-overlay); -webkit-backdrop-filter: blur(var(--overlay-blur)); backdrop-filter: blur(var(--overlay-blur)); }
.island-sheet-overlay[data-state='open'] { animation: island-sheet-fade var(--motion-medium) var(--motion-ease-out); }
.island-sheet {
  position: fixed; right: 0; bottom: 0; left: 0; z-index: var(--z-dialog); display: grid; gap: 10px; max-height: 78dvh;
  padding: 8px 12px calc(16px + env(safe-area-inset-bottom)); border: 1px solid var(--edge-glass); border-bottom: 0; border-radius: 26px 26px 0 0;
  background: var(--glass-sheen), var(--surface-dock-panel); -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: 0 -24px 60px -12px rgb(var(--shadow-rgb) / 30%); outline: none;
}
.island-sheet[data-state='open'] { animation: island-sheet-up var(--motion-spring) var(--motion-ease-spring); }
.island-sheet[data-state='closed'] { animation: island-sheet-down var(--motion-fast) var(--motion-ease-out); }
.island-sheet-grip { justify-self: center; width: 36px; height: 4px; border-radius: 2px; background: var(--color-border-strong); }
.island-sheet-list { display: grid; gap: 10px; overflow-y: auto; overscroll-behavior: contain; }
.island-sheet-list .team-card { box-shadow: none; }
@keyframes island-sheet-up { from { transform: translateY(100%); } }
@keyframes island-sheet-down { to { transform: translateY(100%); } }
@keyframes island-sheet-fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .island-sheet, .island-sheet-overlay { animation: none !important; } }
:root[data-motion="reduced"] .island-sheet, :root[data-motion="reduced"] .island-sheet-overlay { animation: none !important; }
</style>
