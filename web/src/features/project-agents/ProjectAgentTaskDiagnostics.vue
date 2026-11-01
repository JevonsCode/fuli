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
const facts = computed(() => [
  projectState.value === 'identified' ? null : { key: 'project', text: t(`projectAgents.diagnostics.projectState.${projectState.value}`) },
  assigned.value ? { key: 'assignment', text: t('projectAgents.diagnostics.assignmentState.assigned') } : null,
  executionState.value === 'unreported' ? null : { key: 'execution', text: t(`projectAgents.diagnostics.executionState.${executionState.value}`) },
].filter((fact): fact is { key: string; text: string } => fact !== null))
</script>

<template>
  <!-- Only what is known, on one quiet line: a project already in the card's meta, an
       unassigned task or an unreported run says nothing (Jevons 11-01, 简洁). -->
  <p v-if="facts.length" class="project-agent-task-diagnostics" :aria-label="t('projectAgents.diagnostics.title')" data-task-diagnostics>
    <span v-for="fact in facts" :key="fact.key" :data-task-diagnostic="fact.key">{{ fact.text }}</span>
  </p>
</template>

<style scoped>
.project-agent-task-diagnostics { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 8px 0 0; color: var(--color-muted); font-size: 12px; line-height: 1.55; }
</style>
