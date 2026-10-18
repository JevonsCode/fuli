<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import { UiAvatar, UiChip } from '@/ui'
import type { WorkbenchBoard } from './workbench-board'
import { workLanes, type WorkLane } from './workbench-model'

// 看板: where every piece of work stands, left to right. Questions from Agents
// sit at the top of "needs you", above work waiting for review.
const props = defineProps<{ board: WorkbenchBoard }>()
const LANES: readonly WorkLane[] = ['waiting', 'running', 'stuck', 'done']
const PER_LANE = 8
const lanes = computed(() => workLanes(props.board.tasks))
const questions = computed(() => props.board.attention.filter(item => item.status === 'open'))
const count = (lane: WorkLane) => lanes.value[lane].length + (lane === 'waiting' ? questions.value.length : 0)
const lead = (task: { leadAgentId?: string | null; ownerAgentId?: string | null }) => props.board.agentFace(task.leadAgentId ?? task.ownerAgentId)
</script>

<template>
  <div class="kanban" data-workbench="board">
    <section v-for="lane in LANES" :key="lane" class="kanban-lane" :class="`is-${lane}`" :aria-labelledby="`kanban-${lane}`" :data-lane="lane">
      <header><i aria-hidden="true" /><h3 :id="`kanban-${lane}`">{{ t(`workbench.lanes.${lane}`) }}</h3><span>{{ count(lane) }}</span></header>
      <ul class="kanban-cards">
        <template v-if="lane === 'waiting'">
          <li v-for="item in questions" :key="item.requestId">
            <RouterLink class="kanban-card is-question" :to="board.questionHref(item)" data-kanban-question>
              <UiChip tone="warning">{{ t('workbench.board.question') }}</UiChip>
              <strong>{{ item.title }}</strong>
              <span class="kanban-meta">
                <UiAvatar size="sm" :name="board.agentFace(item.agentId).name" :image="board.agentFace(item.agentId).image"
                  :color="board.agentFace(item.agentId).color" :soft-color="board.agentFace(item.agentId).softColor" status="waiting" />
                <small>{{ board.agentFace(item.agentId).name }} · {{ board.since(item.createdAt) }}</small>
              </span>
            </RouterLink>
          </li>
        </template>
        <li v-for="task in lanes[lane].slice(0, PER_LANE)" :key="task.taskId">
          <RouterLink class="kanban-card" :to="board.taskHref(task)" data-kanban-task>
            <strong>{{ task.title }}</strong>
            <small v-if="lane === 'stuck' && task.failureReason" class="kanban-reason">{{ task.failureReason }}</small>
            <span class="kanban-meta">
              <UiAvatar size="sm" :name="lead(task).name" :image="lead(task).image" :color="lead(task).color" :soft-color="lead(task).softColor"
                :status="task.status === 'running' ? 'working' : lane === 'stuck' ? 'error' : 'none'" />
              <small>{{ board.projectName(task.personalProjectId) }} · {{ board.since(task.completedAt ?? task.updatedAt) }}</small>
            </span>
          </RouterLink>
        </li>
        <li v-if="lanes[lane].length > PER_LANE" class="kanban-more">{{ t('workbench.board.more', { count: lanes[lane].length - PER_LANE }) }}</li>
        <li v-if="!count(lane)" class="kanban-empty">{{ t('workbench.board.empty') }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.kanban { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
.kanban-lane { --lane: var(--color-faint); display: grid; gap: 8px; min-width: 0; padding: 10px; border-radius: var(--radius-card); background: var(--color-surface-subtle); }
.kanban-lane.is-waiting { --lane: var(--color-warning); }
.kanban-lane.is-running { --lane: var(--color-accent); }
.kanban-lane.is-stuck { --lane: var(--color-danger); }
.kanban-lane.is-done { --lane: var(--color-success); }
.kanban-lane header { display: flex; align-items: center; gap: 8px; padding: 2px 4px; }
.kanban-lane header i { width: 8px; height: 8px; border-radius: 50%; background: var(--lane); }
.kanban-lane h3 { margin: 0; font-size: 13px; font-weight: 650; }
.kanban-lane header span { margin-left: auto; color: var(--color-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.kanban-cards { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.kanban-card {
  display: grid; gap: 8px; padding: 12px; border: 1px solid var(--color-border); border-radius: 10px;
  color: inherit; background: var(--color-surface); text-decoration: none;
  transition: border-color var(--motion-fast), box-shadow var(--motion-fast);
}
.kanban-card:hover { position: relative; z-index: 1; border-color: var(--color-border-strong); box-shadow: var(--shadow-sm); }
.kanban-card strong { color: var(--color-ink); font-size: 13px; font-weight: 600; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.kanban-card > .ui-chip { justify-self: start; }
.kanban-reason { color: var(--color-danger); font-size: 12px; line-height: 1.5; }
.kanban-meta { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kanban-meta small { overflow: hidden; color: var(--color-faint); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.kanban-more, .kanban-empty { padding: 6px 4px; color: var(--color-faint); font-size: 12px; }
@media (max-width: 1100px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .kanban { grid-template-columns: minmax(0, 1fr); } }
</style>
