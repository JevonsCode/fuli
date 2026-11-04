<script setup lang="ts">
import { UiIcon } from '@/ui'
import { motion } from 'motion-v'
import { computed, ref, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import TaskBlockerClear from '@/features/project-agents/TaskBlockerClear.vue'
import TaskBlockerNotice from '@/features/project-agents/TaskBlockerNotice.vue'
import { statusTone, taskStatusTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import type { ProjectAgentTaskRecord } from '@/types'
import FlaArc from './FlaArc.vue'
import WorkbenchCast from './WorkbenchCast.vue'
import WorkbenchTimeline from './WorkbenchTimeline.vue'
import { taskTimeline, timelineCounts } from './task-timeline'
import { flaProgress, taskFlas, taskKey } from './workbench-model'

// The workbench's fixed left half: the one piece of work you are looking at,
// how many of its FLAs finished their part, what happened on it and, beside
// that, who is on it and its project. Everything shown is what the task records.
const props = defineProps<{
  task: ProjectAgentTaskRecord | null
  spaceId: string
  title: (task: ProjectAgentTaskRecord) => string
  projectName: (id?: string | null) => string
  agentName: (id?: string | null) => string
  statusLabel: (status: string) => string
  next: { to: RouteLocationRaw; label: string } | null
  /** The task whose title is flying in from the column, if any. */
  flying: string
  /** The task read hit its page limit: an empty stage must not claim there is no work. */
  partial: boolean
}>()
const emit = defineEmits<{ cleared: [] }>()

const progress = computed(() => (props.task ? flaProgress(props.task) : { done: 0, total: 0 }))
const flas = computed(() => (props.task ? taskFlas(props.task) : []))
const timeline = computed(() => (props.task ? taskTimeline(props.task) : []))
const counts = computed(() => timelineCounts(timeline.value))
// Choosing an FLA beside the timeline shows only its steps; a new task shows everyone's.
const only = ref<string | null>(null)
watch(() => (props.task ? taskKey(props.task) : ''), () => { only.value = null })
const steps = computed(() => (only.value ? timeline.value.filter(entry => entry.agentId === only.value) : timeline.value))
const project = computed(() => {
  const id = props.task?.personalProjectId
  if (!id) return null
  const registered = props.task?.projectScope?.type !== 'temporary'
  return { name: props.projectName(id), to: registered ? `/personal/${encodeURIComponent(props.spaceId)}/projects/${encodeURIComponent(id)}/directory` : null }
})
const LIVE = new Set(['running', 'queued', 'awaiting_recruitment'])
</script>

<template>
  <!-- The same layout id on a task's title here and in the column moves it between the two; the stage
       glows once as it lands (Jevons 11-04: a click that only made the row vanish read as a bug). -->
  <section class="workbench-stage" :class="{ 'is-arriving': task && flying === taskKey(task) }" :aria-label="t('overview.stage.aria')" data-workbench-stage>
    <template v-if="task">
      <motion.div :key="taskKey(task)" class="workbench-stage-body" :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }" :transition="SPRING">
        <header class="workbench-stage-head">
          <div class="workbench-stage-heading">
            <p v-if="!timeline.length && !flas.length" class="workbench-meta">{{ projectName(task.personalProjectId) }}</p>
            <motion.h2 :layout-id="`work-title-${taskKey(task)}`" class="workbench-stage-title" :transition="SPRING">{{ title(task) }}</motion.h2>
            <div class="workbench-stage-actions">
              <!-- Where the work stands and what to do about it are one control (Jevons 11-04). -->
              <RouterLink v-if="next" :to="next.to" class="workbench-next" :data-tone="statusTone(task.status)" draggable="false" data-workbench-next>
                <span v-if="task.status !== 'running'" class="workbench-next-status">{{ statusLabel(task.status) }}</span>
                <span class="workbench-next-label">{{ next.label }}</span>
                <UiIcon name="chevron-right" :size="14" class="workbench-next-arrow" />
              </RouterLink>
              <Badge v-else-if="task.status !== 'running'" :variant="taskStatusTone(task.status)">{{ statusLabel(task.status) }}</Badge>
            </div>
          </div>
          <FlaArc v-if="progress.total" :done="progress.done" :total="progress.total" />
        </header>
        <div v-if="task.status === 'blocked' && task.blocker" class="workbench-stage-blocker">
          <TaskBlockerNotice :blocker="task.blocker" :updated-at="task.updatedAt" />
          <TaskBlockerClear v-if="task.personalProjectId" :title="title(task)" :blocker="task.blocker" :updated-at="task.updatedAt"
            :scope="{ personalSpaceId: spaceId, personalProjectId: task.personalProjectId, taskId: task.taskId }" @cleared="emit('cleared')" />
        </div>
        <!-- The timeline, and beside it who is on the work and its project. Nothing recorded, no panel. -->
        <section v-if="timeline.length || flas.length" class="workbench-stage-lower" :aria-label="t('overview.stage.viewsAria')">
          <div v-if="timeline.length" class="workbench-view">
            <h3 class="workbench-panel-title">{{ t('overview.stage.views.timeline') }}</h3>
            <Transition name="workbench-view" mode="out-in">
              <WorkbenchTimeline :key="only ?? ''" :entries="steps" :task-key="taskKey(task)" :agent-name="agentName" :live="LIVE.has(task.status)" />
            </Transition>
          </div>
          <WorkbenchCast v-model="only" :flas="flas" :counts="counts" :agent-name="agentName" :status-label="statusLabel" :project="project" />
        </section>
      </motion.div>
    </template>
    <p v-else class="workbench-stage-empty">{{ t(partial ? 'overview.read.partial' : 'overview.work.empty') }}</p>
  </section>
</template>

<style scoped>
.workbench-stage {
  position: relative; display: flex; min-width: 0; min-height: 0; padding: 24px 28px; overflow: hidden;
  border-radius: var(--radius-shell); background: var(--surface-panel-glass); -webkit-backdrop-filter: var(--filter-panel); backdrop-filter: var(--filter-panel); box-shadow: 0 0 0 1px var(--color-border);
}
/* A ring that brightens and fades once: opacity only, so it costs the compositor nothing. */
.workbench-stage::after {
  position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 2px var(--color-accent);
  opacity: 0; pointer-events: none; content: '';
}
.workbench-stage.is-arriving::after { animation: workbench-arrive 900ms var(--motion-ease-spring, ease-out); }
@keyframes workbench-arrive { 0% { opacity: 0; } 25% { opacity: .55; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .workbench-stage.is-arriving::after { animation: none; } }
:root[data-motion="reduced"] .workbench-stage.is-arriving::after { animation: none; }
.workbench-stage-body { display: flex; flex: 1; flex-direction: column; gap: 20px; min-width: 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.workbench-stage-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.workbench-stage-heading { display: grid; gap: 8px; min-width: 0; }
.workbench-next {
  display: inline-flex; align-items: center; gap: 8px; height: var(--control-height-sm); padding: 0 8px 0 3px; border: 1px solid var(--color-border);
  border-radius: var(--radius-pill); color: var(--color-ink); background: var(--color-surface); font-size: 12px; font-weight: var(--weight-medium);
  text-decoration: none; white-space: nowrap; user-select: none; transition: border-color var(--motion-fast) var(--motion-ease);
}
.workbench-next:hover { border-color: var(--color-border-strong); }
.workbench-next:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.workbench-next-status { display: inline-flex; align-items: center; height: calc(var(--control-height-sm) - 8px); padding: 0 9px; border-radius: var(--radius-pill); color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.workbench-next-label:first-child { margin-left: 9px; }
.workbench-next[data-tone="danger"] .workbench-next-status { color: var(--color-danger); background: var(--color-danger-soft); }
.workbench-next[data-tone="warning"] .workbench-next-status { color: var(--color-warning); background: var(--color-warning-soft); }
.workbench-next[data-tone="success"] .workbench-next-status { color: var(--color-success); background: var(--color-success-soft); }
.workbench-next[data-tone="active"] .workbench-next-status { color: var(--color-accent); background: var(--color-accent-soft); }
.workbench-next-arrow { color: var(--color-muted); transition: transform var(--motion-fast) var(--motion-ease); }
.workbench-next:hover .workbench-next-arrow { transform: translateX(2px); }
@media (prefers-reduced-motion: reduce) { .workbench-next-arrow { transition: none; } .workbench-next:hover .workbench-next-arrow { transform: none; } }
:root[data-motion="reduced"] .workbench-next-arrow { transition: none; }
:root[data-motion="reduced"] .workbench-next:hover .workbench-next-arrow { transform: none; }
.workbench-stage-title { margin: 0; font-size: 30px; font-weight: var(--weight-strong); line-height: 1.25; letter-spacing: -.02em; overflow-wrap: anywhere; }
.workbench-stage-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.workbench-meta { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.workbench-stage-blocker { display: grid; gap: 8px; }
.workbench-stage-lower {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(150px, 200px); align-items: start; gap: 14px 24px;
  padding-top: 18px; border-top: 1px solid var(--color-border);
}
.workbench-panel-title { margin: 0 0 14px; font-size: var(--text-body); font-weight: var(--weight-strong); }
.workbench-view { min-width: 0; }
.workbench-stage-lower > :only-child { grid-column: 1 / -1; }
.workbench-view-enter-active, .workbench-view-leave-active { transition: opacity var(--motion-fast) var(--motion-ease), translate var(--motion-fast) var(--motion-ease); }
.workbench-view-enter-from { opacity: 0; translate: 0 4px; }
.workbench-view-leave-to { opacity: 0; }
.workbench-empty, .workbench-stage-empty { margin: 0; color: var(--color-muted); font-size: var(--text-body); }
.workbench-stage-empty { margin: auto; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1100px) {
  .workbench-stage-head { flex-direction: column; align-items: flex-start; }
  /* A narrow stage: who is on it reads first, above the timeline. */
  .workbench-stage-lower { grid-template-columns: minmax(0, 1fr); }
  .workbench-stage-lower > .cast { order: -1; }
}
@media (max-width: 860px) {
  /* One column: the stage grows with its content and the page scrolls. */
  .workbench-stage { padding: 20px; overflow: visible; }
  .workbench-stage-body { overflow: visible; }
  .workbench-stage-title { font-size: 24px; }
}
</style>
