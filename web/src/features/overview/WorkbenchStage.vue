<script setup lang="ts">
import { motion } from 'motion-v'
import { computed, ref, watch } from 'vue'
import { RouterLink, type RouteLocationRaw } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import TaskBlockerClear from '@/features/project-agents/TaskBlockerClear.vue'
import TaskBlockerNotice from '@/features/project-agents/TaskBlockerNotice.vue'
import { taskStatusTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import type { ProjectAgentTaskRecord } from '@/types'
import { UiSegmented } from '@/ui'
import FlaArc from './FlaArc.vue'
import WorkbenchTimeline from './WorkbenchTimeline.vue'
import { taskTimeline } from './task-timeline'
import { flaProgress, taskFlas, taskKey } from './workbench-model'

// The workbench's fixed left half: the one piece of work you are looking at,
// how many of its FLAs finished their part, what happened on it and what each
// FLA is doing now. Everything shown is what the task records.
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
// FLA 分工 only when some FLA holds a part of the work.
const views = computed(() => [
  { value: 'timeline' as const, label: t('overview.stage.views.timeline'), count: timeline.value.length },
  ...(flas.value.length ? [{ value: 'flas' as const, label: t('overview.stage.views.flas'), count: flas.value.length }] : []),
])
const view = ref<'timeline' | 'flas'>('timeline')
watch(() => (props.task ? taskKey(props.task) : ''), () => { view.value = 'timeline' })
const LIVE = new Set(['running', 'queued', 'awaiting_recruitment'])
</script>

<template>
  <section class="workbench-stage" :aria-label="t('overview.stage.aria')" data-workbench-stage>
    <template v-if="task">
      <motion.div :key="taskKey(task)" class="workbench-stage-body" :initial="{ opacity: 0, y: 8 }" :animate="{ opacity: 1, y: 0 }" :transition="SPRING">
        <header class="workbench-stage-head">
          <div class="workbench-stage-heading">
            <p class="workbench-meta">{{ projectName(task.personalProjectId) }}</p>
            <motion.h2 :layout-id="flying === taskKey(task) ? `work-title-${flying}` : undefined" class="workbench-stage-title" :transition="SPRING">{{ title(task) }}</motion.h2>
            <div class="workbench-stage-actions">
              <Badge v-if="task.status !== 'running'" :variant="taskStatusTone(task.status)">{{ statusLabel(task.status) }}</Badge>
              <Button v-if="next" as-child size="sm"><RouterLink :to="next.to" data-workbench-next>{{ next.label }}</RouterLink></Button>
            </div>
          </div>
          <FlaArc v-if="progress.total" :done="progress.done" :total="progress.total" />
        </header>
        <div v-if="task.status === 'blocked' && task.blocker" class="workbench-stage-blocker">
          <TaskBlockerNotice :blocker="task.blocker" :updated-at="task.updatedAt" />
          <TaskBlockerClear v-if="task.personalProjectId" :title="title(task)" :blocker="task.blocker" :updated-at="task.updatedAt"
            :scope="{ personalSpaceId: spaceId, personalProjectId: task.personalProjectId, taskId: task.taskId }" @cleared="emit('cleared')" />
        </div>
        <!-- One full-width panel; its switch shows the timeline or each FLA's share, one at a time. -->
        <section class="workbench-stage-lower" :aria-label="t('overview.stage.viewsAria')">
          <UiSegmented v-if="views.length > 1" v-model="view" class="workbench-views" :options="views" :label="t('overview.stage.viewsAria')" />
          <h3 v-else class="workbench-panel-title">{{ t('overview.stage.views.timeline') }}</h3>
          <Transition name="workbench-view" mode="out-in">
            <div v-if="view === 'timeline' || views.length === 1" key="timeline" class="workbench-view">
              <WorkbenchTimeline v-if="timeline.length" :entries="timeline" :task-key="taskKey(task)" :agent-name="agentName" />
              <p v-else class="workbench-empty">{{ t('overview.stage.noLog') }}</p>
            </div>
            <ul v-else key="flas" class="workbench-flas workbench-view" data-workbench-flas>
              <li v-for="fla in flas" :key="fla.agentId">
                <span class="workbench-face" :style="agentIdentityStyle(fla.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(fla.agentId)" alt="" /></span>
                <p>
                  <strong>{{ agentName(fla.agentId) }}</strong>
                  <span>{{ fla.assignmentSummary?.trim() || statusLabel(fla.status) }}</span>
                </p>
                <span v-if="LIVE.has(fla.status)" class="workbench-live" :title="statusLabel(fla.status)" />
                <span v-else class="sr-only">{{ statusLabel(fla.status) }}</span>
              </li>
            </ul>
          </Transition>
        </section>
      </motion.div>
    </template>
    <p v-else class="workbench-stage-empty">{{ t(partial ? 'overview.read.partial' : 'overview.work.empty') }}</p>
  </section>
</template>

<style scoped>
.workbench-stage {
  display: flex; min-width: 0; min-height: 0; padding: 24px 28px; overflow: hidden;
  border-radius: var(--radius-shell); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border);
}
.workbench-stage-body { display: flex; flex: 1; flex-direction: column; gap: 20px; min-width: 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; }
.workbench-stage-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.workbench-stage-heading { display: grid; gap: 8px; min-width: 0; }
.workbench-stage-title { margin: 0; font-size: 30px; font-weight: var(--weight-strong); line-height: 1.25; letter-spacing: -.02em; overflow-wrap: anywhere; }
.workbench-stage-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.workbench-meta { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.workbench-stage-blocker { display: grid; gap: 8px; }
.workbench-stage-lower { display: grid; align-content: start; gap: 14px; padding-top: 18px; border-top: 1px solid var(--color-border); }
.workbench-views { justify-self: start; }
.workbench-panel-title { margin: 0; font-size: var(--text-body); font-weight: var(--weight-strong); }
.workbench-view { min-width: 0; }
.workbench-view-enter-active, .workbench-view-leave-active { transition: opacity var(--motion-fast) var(--motion-ease), translate var(--motion-fast) var(--motion-ease); }
.workbench-view-enter-from { opacity: 0; translate: 0 4px; }
.workbench-view-leave-to { opacity: 0; }
.workbench-flas { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.workbench-flas li + li { border-top: 1px solid var(--color-border); }
.workbench-flas p { margin: 0; overflow-wrap: anywhere; }
.workbench-flas strong { margin-right: 6px; color: var(--color-ink); font-weight: var(--weight-strong); }
.workbench-flas li { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 7px 0; font-size: var(--text-control); }
.workbench-flas p span { color: var(--color-ink-soft); }
.workbench-face { display: grid; width: 32px; height: 32px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-accent-soft)); }
.workbench-face img { width: 100%; height: 100%; object-fit: cover; }
.workbench-live { width: 7px; height: 7px; border-radius: 50%; background: var(--color-gold); box-shadow: 0 0 0 3px var(--color-gold-soft); }
.workbench-empty, .workbench-stage-empty { margin: 0; color: var(--color-muted); font-size: var(--text-body); }
.workbench-stage-empty { margin: auto; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1100px) {
  .workbench-stage-head { flex-direction: column; align-items: flex-start; }
}
@media (max-width: 860px) {
  /* One column: the stage grows with its content and the page scrolls. */
  .workbench-stage { padding: 20px; overflow: visible; }
  .workbench-stage-body { overflow: visible; }
  .workbench-stage-title { font-size: 24px; }
}
</style>
