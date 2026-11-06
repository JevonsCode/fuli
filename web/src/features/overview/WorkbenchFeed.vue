<script setup lang="ts">
import { motion } from 'motion-v'
import { computed, reactive } from 'vue'
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
// Each list shows its first seven (Jevons 11-06); 更多 at the card's head opens the rest in place.
const FEED_ROWS = 7
const expanded = reactive({ running: false, done: false })
const shownRunning = computed(() => (expanded.running ? solo.value : solo.value.slice(0, FEED_ROWS)))
const shownDone = computed(() => (expanded.done ? props.done : props.done.slice(0, FEED_ROWS)))
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
          <span class="workbench-face" :style="agentIdentityStyle(item.agentId)" aria-hidden="true"><img :src="agentAvatarUrl(item.agentId)" :data-agent-portrait="item.agentId" alt="" /></span>
          <div class="workbench-row-text">
            <p class="workbench-row-title">{{ item.title?.trim() || t('overview.missing.requestTitle') }}</p>
            <p class="workbench-meta">{{ t('overview.attention.meta', { name: agentName(item.agentId), time: formatTime(item.createdAt) }) }}</p>
          </div>
          <Button as-child variant="outline" size="sm"><RouterLink :to="inboxLocation(item.agentId, item.requestId)">{{ t('overview.attention.respond') }}</RouterLink></Button>
        </li>
      </TransitionGroup>
    </section>

    <!-- With nothing else in progress the stage already says so; the card stays away. -->
    <WidgetSlot place="workbench.feed" />
    <section v-if="solo.length || tasksState.loading || tasksState.error" class="workbench-card" aria-labelledby="workbench-running-heading" data-workbench-running>
      <header class="workbench-card-head">
        <h2 id="workbench-running-heading">{{ t('overview.sections.currentWork') }}</h2>
        <Button v-if="solo.length > FEED_ROWS" variant="ghost" size="sm" :aria-expanded="expanded.running" data-workbench-more="running" @click="expanded.running = !expanded.running">
          {{ expanded.running ? t('overview.more.less') : t('overview.more.more', { count: solo.length - FEED_ROWS }) }}
        </Button>
      </header>
      <OverviewReadStatus :state="tasksState" :label="t('overview.work.loading')" :failed="t('overview.work.loadFailed')" @retry="emit('retryTasks')" />
      <!-- A picked task leaves with its title flying to the stage; the rest close up instead of jumping. -->
      <TransitionGroup v-if="solo.length" name="ui-list" tag="ul" class="workbench-rows">
        <li v-for="task in shownRunning" :key="taskKey(task)">
          <Button variant="ghost" class="workbench-row workbench-pick" :aria-label="t('overview.stage.switchTo', { title: title(task) })" data-workbench-pick @click="emit('select', task)">
            <span class="workbench-face" :style="agentIdentityStyle(task.leadAgentId ?? task.ownerAgentId)" aria-hidden="true">
              <img v-if="task.leadAgentId || task.ownerAgentId" :src="agentAvatarUrl(task.leadAgentId ?? task.ownerAgentId ?? '')" :data-agent-portrait="task.leadAgentId ?? task.ownerAgentId ?? ''" alt="" />
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

    <section class="workbench-card" aria-labelledby="workbench-done-heading" data-workbench-done>
      <header class="workbench-card-head">
        <h2 id="workbench-done-heading">{{ t('overview.sections.recentlyDone') }}</h2>
        <Button v-if="done.length > FEED_ROWS" variant="ghost" size="sm" :aria-expanded="expanded.done" data-workbench-more="done" @click="expanded.done = !expanded.done">
          {{ expanded.done ? t('overview.more.less') : t('overview.more.more', { count: done.length - FEED_ROWS }) }}
        </Button>
      </header>
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
.workbench-face { display: grid; width: 34px; height: 34px; overflow: hidden; place-items: center; border-radius: 50%; background: var(--agent-identity-soft, var(--color-accent-soft)); }
.workbench-face img { width: 100%; height: 100%; object-fit: cover; }
.workbench-face-none { width: 16px; height: 16px; color: var(--color-muted); }
.workbench-done-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; color: var(--color-gold); background: var(--color-gold-soft); font-weight: var(--weight-strong); }
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
