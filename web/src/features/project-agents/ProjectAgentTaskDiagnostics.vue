<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import type { ProjectAgentTaskRecord } from '@/types'
import { workerEventEvidence } from './task-evidence'

const props = defineProps<{ task: ProjectAgentTaskRecord; projectName: string }>()
const assigned = computed(() => Boolean(props.task.ownerAgentId || props.task.leadAgentId
  || props.task.participants.some(participant => participant.agentId)))
const projectState = computed(() => props.task.projectScope?.type === 'temporary'
  ? 'temporary' : props.task.personalProjectId ? 'identified' : 'unresolved')
const reportedWorkers = computed(() => {
  if (props.task.executionSummary !== undefined) return props.task.executionSummary
  // Use the latest report per worker so an earlier running event never overrides its terminal report.
  const latest = new Map<string, { status?: string | null; createdAt: string }>()
  for (const event of workerEventEvidence(props.task)) {
    const key = event.workerId || event.agentId || event.workerLabel || event.eventId
    const previous = latest.get(key)
    if (!previous || event.createdAt >= previous.createdAt) {
      latest.set(key, { status: event.workerStatus, createdAt: event.createdAt })
    }
  }
  return [...latest.values()]
})
const executionState = computed(() => {
  const workers = reportedWorkers.value
  if (!workers.length) return 'unreported'
  if (workers.some(worker => worker.status === 'running')) return 'running'
  if (workers.every(worker => worker.status === 'queued')) return 'queued'
  if (workers.every(worker => ['completed', 'failed', 'cancelled'].includes(worker.status ?? ''))) return 'ended'
  return 'reported'
})
const summaryReason = computed(() => {
  if (props.task.executionSummary?.length) return ''
  if (reportedWorkers.value.length) return 'eventsOnly'
  return assigned.value ? 'assignedOnly' : 'unassigned'
})
</script>

<template>
  <section class="project-agent-task-diagnostics" :aria-label="t('projectAgents.diagnostics.title')">
    <dl>
      <div data-task-project-state>
        <dt>{{ t('projectAgents.diagnostics.project') }}</dt>
        <dd>{{ t(`projectAgents.diagnostics.projectState.${projectState}`) }}</dd>
        <small v-if="task.personalProjectId">{{ projectName }}</small>
      </div>
      <div data-task-assignment-state>
        <dt>{{ t('projectAgents.diagnostics.assignment') }}</dt>
        <dd>{{ t(`projectAgents.diagnostics.assignmentState.${assigned ? 'assigned' : 'unreported'}`) }}</dd>
      </div>
      <div data-task-execution-state>
        <dt>{{ t('projectAgents.diagnostics.execution') }}</dt>
        <dd>{{ t(`projectAgents.diagnostics.executionState.${executionState}`) }}</dd>
      </div>
    </dl>
    <p v-if="projectState === 'temporary'" class="project-agent-task-scope-hint">{{ t('projectAgents.diagnostics.temporaryHint') }}</p>
    <p v-if="summaryReason" data-task-summary-reason>{{ t(`projectAgents.diagnostics.summaryReason.${summaryReason}`) }}</p>
  </section>
</template>

<style scoped>
/* Quiet status lines: the three facts stay visible without a boxed grid competing with the task itself. */
.project-agent-task-diagnostics { margin: 8px 0 0; color: var(--color-muted); font-size: 12px; line-height: 1.55; }
.project-agent-task-diagnostics dl { display: grid; gap: 2px; margin: 0; }
.project-agent-task-diagnostics dl > div { display: inline-flex; align-items: baseline; gap: 4px; min-width: 0; }
.project-agent-task-diagnostics dt { color: var(--color-muted); }
.project-agent-task-diagnostics dt::after { content: ':'; }
.project-agent-task-diagnostics dd { margin: 0; color: var(--color-ink); overflow-wrap: anywhere; }
.project-agent-task-diagnostics small { color: var(--color-muted); }
.project-agent-task-diagnostics small::before { content: '('; }
.project-agent-task-diagnostics small::after { content: ')'; }
.project-agent-task-diagnostics p { margin: 4px 0 0; color: var(--color-muted); font-size: 12px; line-height: 1.55; }
</style>
