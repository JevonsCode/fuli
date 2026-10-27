<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { taskStatusChipTone } from '@/features/project-agents/task-labels'
import { t } from '@/i18n'
import { UiAvatar, UiChip, UiIcon } from '@/ui'
import TaskBlockerNotice from '@/features/project-agents/TaskBlockerNotice.vue'
import TaskReason from '@/features/project-agents/TaskReason.vue'
import { taskReason } from '@/features/project-agents/task-reason'
import type { WorkbenchBoard } from './workbench-board'
import { focusItem, workLanes } from './workbench-model'

// 今日焦点: one thing that needs you, then who is working and what is stuck.
const props = defineProps<{ board: WorkbenchBoard }>()
const lanes = computed(() => workLanes(props.board.tasks))
const focus = computed(() => focusItem(props.board.attention, props.board.tasks))
const working = computed(() => lanes.value.running.slice(0, 8))
const stuck = computed(() => lanes.value.stuck.slice(0, 5))
const focusAgent = computed(() => {
  const value = focus.value
  if (!value) return null
  return props.board.agentFace(value.kind === 'question' ? value.attention.agentId : value.task.leadAgentId ?? value.task.ownerAgentId)
})
</script>

<template>
  <div class="focus-board" data-workbench="focus">
    <section class="focus-hero" :class="focus ? `is-${focus.kind}` : 'is-calm'" data-focus-hero>
      <template v-if="focus">
        <span class="focus-kicker">{{ t('workbench.focus.kicker') }}</span>
        <div class="focus-hero-body">
          <UiAvatar v-if="focusAgent" size="lg" :name="focusAgent.name" :image="focusAgent.image" :color="focusAgent.color"
            :soft-color="focusAgent.softColor" :status="focus.kind === 'question' ? 'waiting' : focus.kind === 'stuck' ? 'error' : 'none'" />
          <div class="focus-hero-copy">
            <span class="focus-reason">
              {{ focus.kind === 'question' ? t('workbench.focus.question', { agent: focusAgent?.name ?? '' })
                : focus.kind === 'stuck' ? t('workbench.focus.stuck') : t('workbench.focus.review') }}
            </span>
            <h2>{{ focus.kind === 'question' ? focus.attention.title : focus.task.title }}</h2>
            <p v-if="focus.kind === 'question' && focus.attention.detail">{{ focus.attention.detail }}</p>
            <TaskBlockerNotice v-else-if="focus.kind !== 'question' && focus.task.status === 'blocked' && focus.task.blocker"
              :blocker="focus.task.blocker" :updated-at="focus.task.updatedAt" />
            <TaskReason v-else-if="focus.kind !== 'question' && focus.task.failureReason" :reason="focus.task.failureReason" :fallback="t('overview.missing.reason')" />
            <span class="focus-meta">
              {{ board.projectName(focus.kind === 'question' ? focus.attention.personalProjectId : focus.task.personalProjectId) }}
              · {{ board.since(focus.kind === 'question' ? focus.attention.createdAt : focus.task.updatedAt) }}
            </span>
          </div>
          <Button as-child class="focus-action">
            <RouterLink data-focus-action
              :to="focus.kind === 'question' ? board.questionHref(focus.attention) : board.taskHref(focus.task)">
              {{ focus.kind === 'question' ? t('workbench.focus.answer') : t('workbench.focus.open') }}
              <UiIcon name="chevron-right" :size="16" />
            </RouterLink>
          </Button>
        </div>
      </template>
      <div v-else class="focus-calm">
        <span class="focus-calm-mark" aria-hidden="true"><UiIcon name="check" :size="22" /></span>
        <div><h2>{{ t('workbench.focus.calmTitle') }}</h2><p>{{ t('workbench.focus.calmText') }}</p></div>
      </div>
    </section>

    <div class="focus-columns">
      <section class="focus-panel" aria-labelledby="focus-working">
        <header><h3 id="focus-working">{{ t('workbench.focus.working') }}</h3><span>{{ lanes.running.length }}</span></header>
        <p v-if="!working.length" class="focus-empty">{{ t('workbench.focus.workingEmpty') }}</p>
        <ul v-else class="focus-working">
          <li v-for="task in working" :key="task.taskId">
            <RouterLink :to="board.taskHref(task)" class="focus-row" data-focus-working>
              <UiAvatar size="sm" :name="board.agentFace(task.leadAgentId ?? task.ownerAgentId).name"
                :image="board.agentFace(task.leadAgentId ?? task.ownerAgentId).image"
                :color="board.agentFace(task.leadAgentId ?? task.ownerAgentId).color"
                :soft-color="board.agentFace(task.leadAgentId ?? task.ownerAgentId).softColor"
                :status="task.status === 'running' ? 'working' : 'idle'" />
              <span class="focus-row-copy"><strong>{{ task.title }}</strong>
                <small>{{ board.agentFace(task.leadAgentId ?? task.ownerAgentId).name }} · {{ board.projectName(task.personalProjectId) }}</small></span>
              <span class="focus-row-time">{{ board.since(task.updatedAt) }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="focus-panel" aria-labelledby="focus-stuck">
        <header><h3 id="focus-stuck">{{ t('workbench.focus.stuckTitle') }}</h3><span>{{ lanes.stuck.length }}</span></header>
        <p v-if="!stuck.length" class="focus-empty">{{ t('workbench.focus.stuckEmpty') }}</p>
        <ul v-else class="focus-working">
          <li v-for="task in stuck" :key="task.taskId">
            <RouterLink :to="board.taskHref(task)" class="focus-row" data-focus-stuck>
              <UiChip :tone="taskStatusChipTone(task.status)">{{ board.statusLabel(task.status) }}</UiChip>
              <span class="focus-row-copy"><strong>{{ task.title }}</strong>
                <small :title="(!task.blocker && task.failureReason) || undefined">{{ (!task.blocker && taskReason(task.failureReason)?.text) || board.projectName(task.personalProjectId) }}</small></span>
              <span class="focus-row-time">{{ board.since(task.updatedAt) }}</span>
            </RouterLink>
            <TaskBlockerNotice v-if="task.status === 'blocked' && task.blocker" compact :blocker="task.blocker" :updated-at="task.updatedAt" />
          </li>
        </ul>
        <footer class="focus-done">{{ t('workbench.focus.doneToday', { count: lanes.done.length }) }}</footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.focus-board { display: grid; gap: 16px; }
.focus-hero {
  display: grid; gap: 14px; padding: 22px 24px; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  background: var(--color-surface);
}
.focus-hero.is-question { border-color: color-mix(in srgb, var(--color-warning) 35%, var(--color-border)); }
.focus-hero.is-stuck { border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-border)); }
.focus-kicker { color: var(--color-faint); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.focus-hero-body { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 18px; }
.focus-hero-copy { display: grid; gap: 6px; min-width: 0; }
.focus-reason { color: var(--color-muted); font-size: 13px; }
.focus-hero h2 { margin: 0; color: var(--color-ink); font-size: 20px; font-weight: 700; line-height: 1.35; }
.focus-hero p { margin: 0; color: var(--color-ink-soft); font-size: 13px; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.focus-meta { color: var(--color-faint); font-size: 12px; }
.focus-action { gap: 4px; white-space: nowrap; }
.focus-calm { display: flex; align-items: center; gap: 16px; }
.focus-calm-mark { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 50%; color: var(--color-success); background: var(--color-success-soft); }
.focus-calm h2 { margin: 0 0 4px; font-size: 18px; font-weight: 700; }
.focus-calm p { margin: 0; color: var(--color-muted); font-size: 13px; }
.focus-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.focus-panel { display: grid; align-content: start; gap: 6px; padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.focus-panel header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.focus-panel h3 { margin: 0; font-size: 14px; font-weight: 650; }
.focus-panel header span { color: var(--color-faint); font-size: 13px; font-variant-numeric: tabular-nums; }
.focus-working { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.focus-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 10px; color: inherit; text-decoration: none; }
.focus-row:hover { background: var(--color-surface-hover); }
.focus-row-copy { display: grid; flex: 1; gap: 2px; min-width: 0; }
.focus-row-copy strong { overflow: hidden; color: var(--color-ink); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.focus-row-copy small { overflow: hidden; color: var(--color-faint); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.focus-row-time { flex: 0 0 auto; color: var(--color-faint); font-size: 12px; }
.focus-empty { margin: 4px 0; color: var(--color-muted); font-size: 13px; }
.focus-done { margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--color-border); color: var(--color-muted); font-size: 12px; }
@media (max-width: 900px) {
  .focus-columns { grid-template-columns: minmax(0, 1fr); }
  .focus-hero-body { grid-template-columns: auto minmax(0, 1fr); }
  .focus-action { grid-column: 1 / -1; justify-self: start; }
}
</style>
