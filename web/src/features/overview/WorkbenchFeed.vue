<script setup lang="ts">
import { motion } from 'motion-v'
import { RouterLink } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { inboxLocation, type AgentAttention } from '@/features/project-agents/attention-store'
import { taskStatusTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import type { ProjectAgentTaskRecord } from '@/types'
import OverviewReadStatus from './OverviewReadStatus.vue'
import { taskKey } from './workbench-model'

type ReadState = InstanceType<typeof OverviewReadStatus>['$props']['state']

// The workbench's right half, one scrolling column: what waits for you (only
// when something does), the other work in progress (a click puts it on the
// stage) and what was just finished.
defineProps<{
  requests: AgentAttention[]
  requestsState: ReadState
  requestTotal: number
  running: ProjectAgentTaskRecord[]
  tasksState: ReadState
  done: ProjectAgentTaskRecord[]
  title: (task: ProjectAgentTaskRecord) => string
  agentName: (id?: string | null) => string
  owner: (task: ProjectAgentTaskRecord) => string
  statusLabel: (status: string) => string
  formatTime: (value?: string | null) => string
  /** The task whose title is flying to the stage, if any. */
  flying: string
}>()
const emit = defineEmits<{ select: [task: ProjectAgentTaskRecord]; retryRequests: []; retryTasks: [] }>()
</script>

<template>
  <div class="workbench-feed" data-workbench-feed>
    <section v-if="requests.length || requestsState.loading || requestsState.error" class="workbench-card" aria-labelledby="workbench-waiting-heading" data-workbench-waiting>
      <header class="workbench-card-head">
        <h2 id="workbench-waiting-heading">{{ t('overview.sections.attention') }}</h2>
        <Button v-if="requestTotal > requests.length" as-child variant="ghost" size="sm">
          <RouterLink :to="inboxLocation()">{{ t('overview.attention.all', { count: requestTotal }) }}</RouterLink>
        </Button>
      </header>
      <OverviewReadStatus :state="requestsState" :label="t('overview.attention.loading')" :failed="t('overview.attention.loadFailed')" @retry="emit('retryRequests')" />
      <TransitionGroup name="ui-list" tag="ul" class="workbench-rows">
        <li v-for="item in requests" :key="item.requestId" class="workbench-row" data-workbench-request>
          <span class="workbench-face" :style="agentIdentityStyle(item.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(item.agentId)" alt="" /></span>
          <div class="workbench-row-text">
            <p class="workbench-row-title">{{ item.title?.trim() || t('overview.missing.requestTitle') }}</p>
            <p class="workbench-meta">{{ t('overview.attention.meta', { name: agentName(item.agentId), time: formatTime(item.createdAt) }) }}</p>
          </div>
          <Button as-child variant="outline" size="sm"><RouterLink :to="inboxLocation(item.agentId, item.requestId)">{{ t('overview.attention.respond') }}</RouterLink></Button>
        </li>
      </TransitionGroup>
    </section>

    <!-- With nothing else in progress the stage already says so; the card stays away. -->
    <section v-if="running.length || tasksState.loading || tasksState.error" class="workbench-card" aria-labelledby="workbench-running-heading" data-workbench-running>
      <header class="workbench-card-head"><h2 id="workbench-running-heading">{{ t('overview.sections.currentWork') }}</h2></header>
      <OverviewReadStatus :state="tasksState" :label="t('overview.work.loading')" :failed="t('overview.work.loadFailed')" @retry="emit('retryTasks')" />
      <ul v-if="running.length" class="workbench-rows">
        <li v-for="task in running" :key="taskKey(task)">
          <Button variant="ghost" class="workbench-row workbench-pick" :aria-label="t('overview.stage.switchTo', { title: title(task) })" data-workbench-pick @click="emit('select', task)">
            <span class="workbench-face" :style="agentIdentityStyle(task.leadAgentId ?? task.ownerAgentId)" aria-hidden="true">
              <img v-if="task.leadAgentId || task.ownerAgentId" :src="agentAvatarUrl(task.leadAgentId ?? task.ownerAgentId ?? '')" alt="" />
            </span>
            <span class="workbench-row-text">
              <motion.span :layout-id="flying === taskKey(task) ? `work-title-${flying}` : undefined" class="workbench-row-title" :transition="SPRING">{{ title(task) }}</motion.span>
              <span class="workbench-meta">{{ owner(task) }}</span>
            </span>
            <Badge :variant="taskStatusTone(task.status)">{{ statusLabel(task.status) }}</Badge>
          </Button>
        </li>
      </ul>
    </section>

    <section class="workbench-card" aria-labelledby="workbench-done-heading" data-workbench-done>
      <header class="workbench-card-head"><h2 id="workbench-done-heading">{{ t('overview.sections.recentlyDone') }}</h2></header>
      <TransitionGroup v-if="done.length" name="ui-list" tag="ul" class="workbench-rows">
        <li v-for="task in done" :key="taskKey(task)" class="workbench-row">
          <span class="workbench-done-mark" aria-hidden="true">✓</span>
          <div class="workbench-row-text">
            <p class="workbench-row-title">{{ title(task) }}</p>
            <p v-if="task.resultSummary?.trim()" class="workbench-meta workbench-clamp">{{ task.resultSummary }}</p>
          </div>
          <time class="workbench-meta" :datetime="task.completedAt ?? task.updatedAt ?? undefined">{{ formatTime(task.completedAt ?? task.updatedAt) }}</time>
        </li>
      </TransitionGroup>
      <p v-else-if="tasksState.data && !tasksState.loading" class="workbench-empty">{{ t('overview.done.empty') }}</p>
    </section>
  </div>
</template>

<style scoped>
.workbench-feed { display: flex; flex-direction: column; gap: 16px; min-width: 0; min-height: 0; padding: 0 6px 112px 0; overflow: auto; overscroll-behavior: contain; }
.workbench-card {
  display: grid; gap: 6px; padding: 16px 18px; border: 1px solid var(--edge-glass); border-radius: var(--radius-panel);
  background: var(--surface-glass); box-shadow: inset 0 1px 0 var(--edge-glass), var(--shadow-sm), var(--shadow-md);
}
.workbench-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; }
.workbench-card-head h2 { margin: 0; font-size: var(--text-section); }
.workbench-rows { margin: 0; padding: 0; list-style: none; }
.workbench-rows > li + li { border-top: 1px solid var(--color-border); }
.workbench-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; padding: 10px 0; }
.workbench-row-text { display: grid; gap: 2px; min-width: 0; }
.workbench-row-title { margin: 0; overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.workbench-meta { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.workbench-clamp { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.workbench-face { display: grid; width: 34px; height: 34px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-accent-soft)); }
.workbench-face img { width: 100%; height: 100%; object-fit: cover; }
.workbench-done-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; color: var(--color-gold); background: var(--color-gold-soft); font-weight: var(--weight-strong); }
/* A row that puts its work on the stage: the whole row is the button. */
.workbench-pick {
  height: auto; justify-content: stretch; margin: 0 -8px; padding: 10px 8px; width: calc(100% + 16px); border: 0; border-radius: 12px; color: inherit; background: none; text-align: left; font: inherit; white-space: normal;
  transition: background var(--motion-fast), transform var(--motion-spring) var(--motion-ease-spring);
}
.workbench-pick:hover { background: var(--surface-glass-strong); }
.workbench-pick:active { transform: scale(.98); }
.workbench-empty { margin: 4px 0 8px; color: var(--color-muted); font-size: var(--text-body); }
@media (max-width: 860px) {
  .workbench-feed { padding: 0 0 112px; overflow: visible; }
}
</style>
