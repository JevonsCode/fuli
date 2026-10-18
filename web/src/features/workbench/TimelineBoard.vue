<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { currentLocale, t } from '@/i18n'
import { UiAvatar, UiChip } from '@/ui'
import type { WorkbenchBoard } from './workbench-board'
import { laneOf, timelineHours } from './workbench-model'

// 时间线: the last day, hour by hour: who did what, where, and how it ended.
const props = defineProps<{ board: WorkbenchBoard }>()
const hours = computed(() => timelineHours(props.board.tasks, Date.now(), currentLocale()))
const tone = (status: string) => {
  const lane = laneOf({ status } as never)
  return lane === 'stuck' ? 'danger' : lane === 'waiting' ? 'warning' : lane === 'running' ? 'accent' : 'neutral'
}
const lead = (task: { leadAgentId?: string | null; ownerAgentId?: string | null }) => props.board.agentFace(task.leadAgentId ?? task.ownerAgentId)
</script>

<template>
  <div class="timeline" data-workbench="timeline">
    <p v-if="!hours.length" class="timeline-empty">{{ t('workbench.timeline.empty') }}</p>
    <section v-for="hour in hours" :key="hour.hour" class="timeline-hour" data-timeline-hour>
      <time class="timeline-label">{{ hour.label }}</time>
      <ul class="timeline-items">
        <li v-for="task in hour.tasks" :key="task.taskId" :class="`is-${laneOf(task) ?? 'other'}`">
          <RouterLink class="timeline-item" :to="board.taskHref(task)">
            <UiAvatar size="sm" :name="lead(task).name" :image="lead(task).image" :color="lead(task).color" :soft-color="lead(task).softColor"
              :status="task.status === 'running' ? 'working' : 'none'" />
            <span class="timeline-copy">
              <span><b>{{ lead(task).name }}</b> · {{ board.projectName(task.personalProjectId) }}</span>
              <strong>{{ task.title }}</strong>
            </span>
            <UiChip :tone="tone(task.status)">{{ board.statusLabel(task.status) }}</UiChip>
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.timeline { display: grid; gap: 4px; padding: 16px 20px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.timeline-empty { margin: 8px 0; color: var(--color-muted); font-size: 13px; }
.timeline-hour { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 12px; }
.timeline-label { padding-top: 12px; color: var(--color-faint); font-family: var(--font-mono); font-size: 12px; text-align: right; }
.timeline-items { display: grid; gap: 2px; margin: 0; padding: 4px 0 4px 16px; border-left: 2px solid var(--color-border); list-style: none; }
.timeline-items li { position: relative; }
.timeline-items li::before {
  content: ''; position: absolute; top: 22px; left: -22px; width: 10px; height: 10px; border: 2px solid var(--color-surface);
  border-radius: 50%; background: var(--color-faint);
}
.timeline-items li.is-running::before { background: var(--color-accent); }
.timeline-items li.is-waiting::before { background: var(--color-warning); }
.timeline-items li.is-stuck::before { background: var(--color-danger); }
.timeline-items li.is-done::before { background: var(--color-success); }
.timeline-item { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; color: inherit; text-decoration: none; }
.timeline-item:hover { background: var(--color-surface-hover); }
.timeline-copy { display: grid; flex: 1; gap: 2px; min-width: 0; }
.timeline-copy span { overflow: hidden; color: var(--color-faint); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.timeline-copy b { color: var(--color-ink-soft); font-weight: 600; }
.timeline-copy strong { overflow: hidden; color: var(--color-ink); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
</style>
