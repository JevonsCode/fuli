<script setup lang="ts">
import { motion } from 'motion-v'
import { computed } from 'vue'
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
import type { ProjectAgentTaskEvent, ProjectAgentTaskRecord } from '@/types'
import FlaArc from './FlaArc.vue'
import { flaProgress, taskFlas, taskKey, taskLog } from './workbench-model'

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
  formatTime: (value?: string | null) => string
  next: { to: RouteLocationRaw; label: string } | null
  /** The task whose title is flying in from the column, if any. */
  flying: string
  /** The task read hit its page limit: an empty stage must not claim there is no work. */
  partial: boolean
}>()
const emit = defineEmits<{ cleared: [] }>()

const progress = computed(() => (props.task ? flaProgress(props.task) : { done: 0, total: 0 }))
const flas = computed(() => (props.task ? taskFlas(props.task) : []))
const log = computed(() => (props.task ? taskLog(props.task) : []))
const actor = (event: ProjectAgentTaskEvent) => event.agentId ? props.agentName(event.agentId)
  : event.actorKind === 'human' ? t('overview.stage.you') : t('overview.stage.system')
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
        <div class="workbench-stage-lower">
          <section class="workbench-panel" aria-labelledby="workbench-log-heading">
            <h3 id="workbench-log-heading" class="workbench-panel-title">{{ t('overview.sections.log') }}</h3>
            <ol v-if="log.length" class="workbench-log">
              <li v-for="event in log" :key="event.eventId">
                <time :datetime="event.createdAt">{{ formatTime(event.createdAt) }}</time>
                <p><strong>{{ actor(event) }}</strong>{{ event.summary }}</p>
              </li>
            </ol>
            <p v-else class="workbench-empty">{{ t('overview.stage.noLog') }}</p>
          </section>
          <section class="workbench-panel" aria-labelledby="workbench-flas-heading">
            <h3 id="workbench-flas-heading" class="workbench-panel-title">{{ t('overview.sections.flas') }}</h3>
            <ul class="workbench-flas">
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
          </section>
        </div>
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
.workbench-stage-body { display: flex; flex: 1; flex-direction: column; gap: 20px; min-width: 0; min-height: 0; }
.workbench-stage-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.workbench-stage-heading { display: grid; gap: 8px; min-width: 0; }
.workbench-stage-title { margin: 0; font-size: 30px; font-weight: var(--weight-strong); line-height: 1.25; letter-spacing: -.02em; overflow-wrap: anywhere; }
.workbench-stage-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.workbench-meta { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.workbench-stage-blocker { display: grid; gap: 8px; }
.workbench-stage-lower {
  display: grid; flex: 1; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 24px; min-height: 0;
  padding-top: 18px; border-top: 1px solid var(--color-border);
}
/* The stage never scrolls as a page; a long log scrolls inside its own column. */
.workbench-panel { display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; }
.workbench-panel + .workbench-panel { padding-left: 24px; border-left: 1px solid var(--color-border); }
.workbench-panel-title { margin: 0; font-size: var(--text-body); font-weight: var(--weight-strong); }
.workbench-log, .workbench-flas { display: flex; flex-direction: column; min-height: 0; margin: 0; padding: 0; overflow: auto; list-style: none; }
.workbench-log li { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px; padding: 8px 0; color: var(--color-ink-soft); font-size: var(--text-control); }
.workbench-log li + li { border-top: 1px solid var(--color-border); }
.workbench-log li:first-child p { color: var(--color-ink); }
.workbench-log time { color: var(--color-faint); font-variant-numeric: tabular-nums; }
.workbench-log p, .workbench-flas p { margin: 0; overflow-wrap: anywhere; }
.workbench-log strong, .workbench-flas strong { margin-right: 6px; color: var(--color-ink); font-weight: var(--weight-strong); }
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
  .workbench-log, .workbench-flas { overflow: visible; }
  .workbench-stage-title { font-size: 24px; }
  .workbench-stage-lower { grid-template-columns: minmax(0, 1fr); }
  .workbench-panel + .workbench-panel { padding-top: 16px; padding-left: 0; border-top: 1px solid var(--color-border); border-left: 0; }
}
</style>
