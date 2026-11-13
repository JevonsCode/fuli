<script setup lang="ts">
import AgentAvatar from '@/features/agent-profile/AgentAvatar.vue'
import { motion } from 'motion-v'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { inboxLocation, type AgentAttention } from '@/features/project-agents/attention-store'
import { taskStatusTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { SPRING } from '@/lib/motion'
import type { ProjectAgentTaskRecord } from '@/types'
import AttentionRow from './AttentionRow.vue'
import OverviewReadStatus from './OverviewReadStatus.vue'
import WorkbenchListHead from './WorkbenchListHead.vue'
import { taskKey } from './workbench-model'
import { useTeamWork } from '@/features/team-work/useTeamWork'
import { useConsoleStore } from '@/stores/console'
import WidgetSlot from '@/widgets/WidgetSlot.vue'
import UiIcon from '@/ui/UiIcon.vue'
import './workbench-card.css'

type ReadState = InstanceType<typeof OverviewReadStatus>['$props']['state']

// The workbench's right half, one scrolling column: what waits for you (only
// when something does), whatever the layout puts in the feed slot (team
// cards by default), the other work in progress (a click puts it on the
// stage) and what was just finished.
const props = defineProps<{
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
}>()
const emit = defineEmits<{ select: [task: ProjectAgentTaskRecord]; retryRequests: []; retryTasks: [] }>()
// A task FLAs do together already has its team card; 进行中 keeps the rest.
// Until the team cards have loaded, nothing is held back.
const store = useConsoleStore()
const team = useTeamWork(computed(() => store.activePersonalSpace?.id ?? ''))
const solo = computed(() => {
  if (team.state.value !== 'ready') return props.running
  const together = new Set(team.sheets.value.map(sheet => sheet.taskId))
  return props.running.filter(task => !together.has(task.taskId))
})
// Each list shows its first seven (Jevons 11-06); 更多 at the card's head opens
// the list's own page (/workbench/<list>), with search, filters and the rest.
const FEED_ROWS = 7
const shownRunning = computed(() => solo.value.slice(0, FEED_ROWS))
const shownDone = computed(() => props.done.slice(0, FEED_ROWS))
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
        <li v-for="item in requests" :key="item.requestId"><AttentionRow :item="item" :name="agentName(item.agentId)" :time="formatTime(item.createdAt)" /></li>
      </TransitionGroup>
    </section>

    <!-- With nothing else in progress the stage already says so; the card stays away. -->
    <WidgetSlot place="workbench.feed" />
    <section v-if="solo.length || tasksState.loading || tasksState.error" class="workbench-card" aria-labelledby="workbench-running-heading" data-workbench-running data-list-morph="running">
      <WorkbenchListHead id="workbench-running-heading" list="running" :title="t('overview.sections.currentWork')" :more="solo.length - shownRunning.length" />
      <!-- Until the first read lands the stage column already shows this read's indicator. -->
      <OverviewReadStatus :state="tasksState" :quiet="!tasksState.data" :label="t('overview.work.loading')" :failed="t('overview.work.loadFailed')" @retry="emit('retryTasks')" />
      <!-- A picked task leaves with its title flying to the stage; the rest close up instead of jumping. -->
      <TransitionGroup v-if="solo.length" name="ui-list" tag="ul" class="workbench-rows">
        <li v-for="task in shownRunning" :key="taskKey(task)">
          <Button variant="ghost" class="workbench-row workbench-pick" :aria-label="t('overview.stage.switchTo', { title: title(task) })" data-workbench-pick @click="emit('select', task)">
            <span class="workbench-face" :style="agentIdentityStyle(task.leadAgentId ?? task.ownerAgentId)" aria-hidden="true">
              <AgentAvatar v-if="task.leadAgentId || task.ownerAgentId" :agent-id="task.leadAgentId ?? task.ownerAgentId ?? ''" />
              <!-- Nobody leads it yet: a quiet sign, not an empty circle that looks broken. -->
              <UiIcon v-else name="agents" class="workbench-face-none" data-unassigned />
            </span>
            <span class="workbench-row-text">
              <motion.span :layout-id="`work-title-${taskKey(task)}`" class="workbench-row-title" :transition="SPRING">{{ title(task) }}</motion.span>
              <span class="workbench-meta">{{ owner(task) }}</span>
            </span>
            <Badge :variant="taskStatusTone(task.status)">{{ statusLabel(task.status) }}</Badge>
          </Button>
        </li>
      </TransitionGroup>
    </section>

    <section class="workbench-card" aria-labelledby="workbench-done-heading" data-workbench-done data-list-morph="done">
      <WorkbenchListHead id="workbench-done-heading" list="done" :title="t('overview.sections.recentlyDone')" :more="done.length - shownDone.length" />
      <TransitionGroup v-if="done.length" name="ui-list" tag="ul" class="workbench-rows">
        <li v-for="task in shownDone" :key="taskKey(task)" class="workbench-row">
          <span class="workbench-done-mark" aria-hidden="true"><UiIcon name="check" :size="16" /></span>
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
/* A row that puts its work on the stage: the whole row is the button. */
.workbench-pick {
  height: auto; justify-content: stretch; margin: 0 -8px; padding: 10px 8px; width: calc(100% + 16px); border: 0; border-radius: 12px; color: inherit; background: none; text-align: left; font: inherit; white-space: normal;
  transition: background var(--motion-fast), transform var(--motion-spring) var(--motion-ease-spring);
}
.workbench-pick:hover { background: var(--color-surface-subtle); }
.workbench-pick:active { transform: scale(.98); }
@media (max-width: 860px) {
  .workbench-feed { padding: 0 0 112px; overflow: visible; }
}
</style>
