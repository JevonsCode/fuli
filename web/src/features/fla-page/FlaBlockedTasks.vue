<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { agentManagementPath } from '@/features/project-agents/orchestration-filters'
import { blockerReasonText } from '@/features/project-agents/task-blocker'
import TaskBlockerClear from '@/features/project-agents/TaskBlockerClear.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { readBlockedTasks, type BlockedTask } from './blocked-tasks'

// Widget 'fla-blocked': this FLA's blocked tasks, one row each with the
// reason and the task list's own 「标记为已解除」 on the right. The home page
// (今天) no longer clears blocks; this is where it happens next to the FLA.
// Nothing shows while it reads, when it cannot read, or when nothing is blocked.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string; projectName: (id: string) => string }>()

const store = useConsoleStore()
const tasks = ref<BlockedTask[]>([])
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    const result = await readBlockedTasks(props.spaceId, props.agentId, current.signal)
    if (controller === current) tasks.value = result
  } catch {
    if (controller === current) tasks.value = []
  }
}
watch(() => [props.spaceId, props.agentId], () => { if (props.spaceId && props.agentId) void load() }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

// This FLA's page opened on the task (its work record shows it).
const taskLink = (task: BlockedTask) =>
  `${agentManagementPath(props.spaceId, props.agentId)}?${new URLSearchParams({ task: task.taskId })}`
const scopeOf = (task: BlockedTask) => ({ personalSpaceId: props.spaceId, personalProjectId: task.personalProjectId, taskId: task.taskId })

function cleared(task: BlockedTask) {
  tasks.value = tasks.value.filter(item => item.taskId !== task.taskId)
  store.notify(t('flaPage.blocked.cleared', { title: task.title }), { to: taskLink(task) })
}
</script>

<template>
  <section v-if="tasks.length" class="blocked" aria-labelledby="fla-blocked-heading" data-widget="fla-blocked">
    <h2 id="fla-blocked-heading" class="blocked-label">{{ t('flaPage.blocked.title') }} <span class="ui-num">{{ tasks.length }}</span></h2>
    <TransitionGroup name="ui-list" tag="ul" class="blocked-list">
      <li v-for="task in tasks" :key="task.taskId" class="blocked-row" data-blocked-task>
        <div class="blocked-text">
          <RouterLink class="blocked-title" :to="taskLink(task)" :title="task.title">{{ task.title }}</RouterLink>
          <p class="blocked-reason" data-blocked-reason>{{ blockerReasonText(task.blocker) }}</p>
          <small class="blocked-project">{{ projectName(task.personalProjectId) }}</small>
        </div>
        <TaskBlockerClear class="blocked-action" :scope="scopeOf(task)" :title="task.title" :blocker="task.blocker"
          :updated-at="task.updatedAt" hint="tooltip" @cleared="cleared(task)" />
      </li>
    </TransitionGroup>
  </section>
</template>

<style scoped>
.blocked { display: grid; gap: 12px; }
.blocked-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.blocked-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.blocked-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
/* The action keeps one place on the right of every row, whatever the text beside it. */
.blocked-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 16px;
  border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.blocked-text { display: grid; gap: 2px; min-width: 0; }
.blocked-title { overflow: hidden; color: var(--color-ink); font-size: var(--text-control); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.blocked-reason { margin: 0; color: var(--color-ink-soft); overflow-wrap: anywhere; }
.blocked-project { color: var(--color-muted); font-size: var(--text-meta); }
.blocked-action { justify-content: flex-end; }
</style>
