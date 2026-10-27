<script setup lang="ts">
import { computed, ref } from 'vue'
import { Badge } from '@/components/ui/badge'
import { t } from '@/i18n'
import type { ProjectAgentRecord, ProjectAgentTaskRecord } from '@/types'
import ProjectAgentTaskDiagnostics from './ProjectAgentTaskDiagnostics.vue'
import TaskExecutionPlan from './TaskExecutionPlan.vue'
import TaskRunControls from './TaskRunControls.vue'
import { parallelPlanHasEvidence, workerEventEvidence } from './task-evidence'
import {
  actualExecution,
  executionSummaryOccupationEmoji,
  executionSummarySessionHref,
  executionSummarySessionId,
  executionSummaryStatusLabel,
  executionSummaryWorkerLabel,
  formatDate,
  participantRoleLabel,
  policyLabel,
  sessionHref,
  sourceLabel,
  strategyLabel,
  taskStatusLabel,
  taskStatusTone,
  tokenUsageLabel,
  workerEventLabel,
} from './task-labels'

const props = defineProps<{
  task: ProjectAgentTaskRecord
  projectName: string
  agents: ProjectAgentRecord[]
  personalSpaceId: string
  linked: boolean
}>()

// The execution plan subscribes to live updates only while the details are open.
const emit = defineEmits<{ changed: [] }>()
const expanded = ref(props.linked)
const execution = computed(() => actualExecution(props.task))
const workerEvents = computed(() => workerEventEvidence(props.task))
const participants = computed(() => props.task.participants.map(participant => {
  const agent = props.agents.find(item => item.agentId === participant.agentId)
  return {
    key: participant.agentId,
    label: `${agent?.profile.displayName || agent?.profile.name || participant.agentId} · ${participantRoleLabel(participant.role)}`,
  }
}))

function toggle(event: Event) {
  expanded.value = (event.target as HTMLDetailsElement).open
}
</script>

<template>
  <article :id="`task-${task.taskId}`" class="ui-card project-agent-task-card" :class="{ 'is-linked': linked }">
    <header>
      <div><strong>{{ task.title }}</strong><small>{{ projectName }}</small></div>
      <Badge :variant="taskStatusTone(task.status)" data-task-status>{{ taskStatusLabel(task.status) }}</Badge>
    </header>
    <p v-if="task.resultSummary || task.failureReason">{{ task.resultSummary || task.failureReason }}</p>
    <ProjectAgentTaskDiagnostics :task="task" :project-name="projectName" />
    <p v-if="participants.length" class="project-agent-task-people" data-task-participants>
      {{ t('projectAgents.fields.collaborators') }} · {{ participants.map(participant => participant.label).join('、') }}
    </p>

    <details class="ui-disclosure project-agent-task-details" :open="linked" data-task-details @toggle="toggle">
      <summary>{{ t('projectAgents.taskDetails') }}</summary>
      <TaskExecutionPlan :task="task" :personal-space-id="personalSpaceId" :active="expanded" />
      <TaskRunControls :task="task" :personal-space-id="personalSpaceId" :active="expanded" @changed="emit('changed')" />

      <section v-if="task.executionSummary !== undefined" class="project-agent-execution-summary" :aria-label="t('projectAgents.fields.executionSummary')">
        <div class="project-agent-section-heading">
          <h5>{{ t('projectAgents.fields.executionSummary') }}</h5>
          <span>{{ task.executionSummary.length }}</span>
        </div>
        <div v-if="task.executionSummary.length" class="project-agent-execution-summary-table-wrap" role="region" tabindex="0" :aria-label="t('projectAgents.fields.executionSummary')">
          <table class="project-agent-execution-summary-table">
            <caption class="ui-sr-only">{{ t('projectAgents.fields.executionSummary') }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ t('projectAgents.fields.worker') }}</th>
                <th scope="col">{{ t('projectAgents.fields.workSummary') }}</th>
                <th scope="col">{{ t('projectAgents.fields.toolsUsed') }}</th>
                <th scope="col">{{ t('projectAgents.fields.executionEnvironment') }}</th>
                <th scope="col">{{ t('projectAgents.fields.sourceSession') }}</th>
                <th scope="col">{{ t('projectAgents.fields.tokenUsage') }}</th>
                <th scope="col">{{ t('projectAgents.fields.terminalStatus') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(summary, summaryIndex) in task.executionSummary" :key="task.taskId + ':execution:' + (summary.workerId || summary.agentId || summaryIndex)" class="project-agent-execution-summary-row">
                <th scope="row">
                  <span class="project-agent-execution-worker">
                    <span v-if="executionSummaryOccupationEmoji(summary)" class="project-agent-occupation-emoji" role="img" :aria-label="t('projectAgents.fields.occupationEmoji') + ': ' + executionSummaryOccupationEmoji(summary)">{{ executionSummaryOccupationEmoji(summary) }}</span>
                    {{ executionSummaryWorkerLabel(summary) }}
                  </span>
                  <small v-if="summary.agentId || summary.workerId">{{ summary.workerId || summary.agentId }}</small>
                  <small>{{ participantRoleLabel(summary.participantRole) }}</small>
                </th>
                <td :data-label="t('projectAgents.fields.workSummary')">{{ summary.workSummary || t('projectAgents.notReported') }}</td>
                <td :data-label="t('projectAgents.fields.toolsUsed')">{{ summary.toolsUsed ? summary.toolsUsed.join(' · ') || t('projectAgents.noToolsUsed') : t('projectAgents.notReported') }}</td>
                <td :data-label="t('projectAgents.fields.executionEnvironment')">
                  <strong>{{ summary.executor || t('projectAgents.notReported') }}</strong>
                  <small v-if="summary.executorId && summary.executorId !== summary.executor">{{ summary.executorId }}</small>
                  <small v-if="summary.actualModelProvider || summary.actualModel">{{ [summary.actualModelProvider, summary.actualModel].filter(Boolean).join(' · ') }}</small>
                </td>
                <td :data-label="t('projectAgents.fields.sourceSession')">
                  <span><template v-if="summary.workerRuntime">{{ t('projectAgents.fields.workerSession') }} · </template>{{ sourceLabel(summary.workerRuntime?.application || summary.sourceApplication) }}</span>
                  <a v-if="executionSummarySessionHref(summary)" :href="executionSummarySessionHref(summary) || undefined" target="_blank" rel="noreferrer">{{ executionSummarySessionId(summary) || executionSummarySessionHref(summary) }}</a>
                  <small v-else>{{ executionSummarySessionId(summary) || t('projectAgents.notReported') }}</small>
                  <template v-if="summary.workerRuntime">
                    <small class="project-agent-reporter-label">{{ t('projectAgents.fields.reporterSession') }} · {{ sourceLabel(summary.sourceApplication) }}</small>
                    <a v-if="sessionHref(summary.sourceSessionUrl)" :href="sessionHref(summary.sourceSessionUrl) || undefined" target="_blank" rel="noreferrer">{{ summary.sourceSessionId || summary.sourceSessionUrl }}</a>
                    <small v-else>{{ summary.sourceSessionId || t('projectAgents.notReported') }}</small>
                  </template>
                </td>
                <td :data-label="t('projectAgents.fields.tokenUsage')">{{ tokenUsageLabel(summary.tokenUsage) }}</td>
                <td :data-label="t('projectAgents.fields.terminalStatus')">
                  <Badge v-if="summary.status" :variant="taskStatusTone(summary.status)">{{ executionSummaryStatusLabel(summary.status) }}</Badge>
                  <span v-else>{{ t('projectAgents.notReported') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="project-agent-muted">{{ t('projectAgents.detail.noExecutionSummary') }}</p>
      </section>

      <section v-if="workerEvents.length" class="project-agent-worker-event-evidence" :aria-label="t('projectAgents.fields.workerEventEvidence')">
        <div class="project-agent-section-heading">
          <h5>{{ t('projectAgents.fields.workerEventEvidence') }}</h5>
          <span>{{ workerEvents.length }}</span>
        </div>
        <ul class="project-agent-execution-summary-list">
          <li v-for="event in workerEvents" :key="`${task.taskId}:worker-event:${event.eventId}`" class="project-agent-worker-event-row">
            <header>
              <strong>
                <span v-if="event.workerOccupationEmoji" class="project-agent-occupation-emoji" role="img" :aria-label="`${t('projectAgents.fields.occupationEmoji')}: ${event.workerOccupationEmoji}`">{{ event.workerOccupationEmoji }}</span>
                {{ workerEventLabel(event) }}
                <small v-if="event.agentId">{{ t('projectAgents.fields.agentId') }} · {{ event.agentId }}</small>
              </strong>
              <Badge :variant="taskStatusTone(event.workerStatus || event.status)">{{ executionSummaryStatusLabel(event.workerStatus || event.status) }}</Badge>
            </header>
            <dl class="project-agent-execution-summary-meta">
              <div><dt>{{ t('projectAgents.fields.workSummary') }}</dt><dd>{{ event.summary || t('projectAgents.notReported') }}</dd></div>
              <div><dt>{{ t('projectAgents.fields.sourceApplication') }}</dt><dd>{{ sourceLabel(event.sourceApplication) }}</dd></div>
              <div><dt>{{ t('projectAgents.fields.sourceSession') }}</dt><dd>{{ event.sourceSessionId || t('projectAgents.notReported') }}</dd></div>
              <div><dt>{{ t('projectAgents.fields.tokenUsage') }}</dt><dd>{{ tokenUsageLabel(event.tokenUsage) }}</dd></div>
              <div v-if="event.actualModelProvider || event.actualModel"><dt>{{ t('projectAgents.fields.actualModel') }}</dt><dd>{{ [event.actualModelProvider, event.actualModel].filter(Boolean).join(' · ') }}</dd></div>
              <div><dt>{{ t('projectAgents.fields.reportedAt') }}</dt><dd>{{ formatDate(event.createdAt) }}</dd></div>
            </dl>
          </li>
        </ul>
      </section>

      <div class="project-agent-execution-line">
        <span>{{ t('projectAgents.fields.actualExecution') }}</span>
        <strong v-if="execution">{{ execution.executor || execution.provider || t('projectAgents.notReported') }} / {{ execution.model || t('projectAgents.notReported') }} / {{ sourceLabel(execution.client) }}</strong>
        <span v-else>{{ t('projectAgents.detail.notReportedActualExecution') }}</span>
        <small v-if="execution?.rule || execution?.fallback">{{ execution?.rule || t('projectAgents.notReported') }} · {{ execution?.fallback || t('projectAgents.notReported') }}</small>
      </div>

      <details class="project-agent-task-tech" data-task-tech>
        <summary>{{ t('projectAgents.techDetails') }}</summary>
        <small>{{ task.taskId }}</small>
        <small v-if="task.runId">{{ t('projectAgents.fields.run') }} · {{ task.runId }}</small>
        <small v-else>{{ t('projectAgents.detail.noRun') }}</small>
        <small v-if="task.effectiveModelStrategy">{{ t('projectAgents.fields.strategySource') }} · {{ task.modelStrategySource || t('projectAgents.notReported') }} · {{ strategyLabel(task.effectiveModelStrategy) }} · {{ policyLabel(task.effectiveExecutorPolicy) }}</small>
        <div v-if="task.routingDecision" class="project-agent-routing-decision">
          <div class="project-agent-section-heading">
            <span>{{ t('projectAgents.fields.reportedStaffingDecision') }}</span>
            <strong>{{ task.routingDecision.outcome || t('projectAgents.notReported') }}</strong>
          </div>
          <small v-if="task.routingDecision.coordinatorAgentId || task.coordinatorAgentId">{{ t('projectAgents.fields.coordinator') }} · {{ task.routingDecision.coordinatorAgentId || task.coordinatorAgentId }}</small>
          <small>{{ t('projectAgents.fields.matchBasis') }} · {{ task.routingDecision.matchBasis?.join(' · ') || t('projectAgents.notReported') }} · {{ task.routingDecision.reason || t('projectAgents.notReported') }}</small>
          <small v-if="task.routingDecision.candidateAgentIds?.length">{{ t('projectAgents.fields.candidateAgents') }} · {{ task.routingDecision.candidateAgentIds.join(' · ') }}</small>
          <small v-if="task.routingDecision.complexity !== null && task.routingDecision.complexity !== undefined">{{ t('projectAgents.fields.complexity') }} · {{ task.routingDecision.complexity }}<span v-if="task.routingDecision.complexityBasis?.length"> · {{ task.routingDecision.complexityBasis.join(' · ') }}</span></small>
          <small v-if="parallelPlanHasEvidence(task.routingDecision.parallelPlan)">{{ t('projectAgents.fields.parallelPlan') }} · {{ task.routingDecision.parallelPlan?.reason || t('projectAgents.notReported') }}<span v-if="task.routingDecision.parallelPlan?.workstreamBoundaries?.length"> · {{ task.routingDecision.parallelPlan.workstreamBoundaries.join(' · ') }}</span></small>
          <small v-if="task.routingDecision.ruleId || task.routingDecision.fallback">{{ task.routingDecision.ruleId || t('projectAgents.notReported') }} · {{ task.routingDecision.fallback || t('projectAgents.notReported') }}</small>
        </div>
      </details>
    </details>
  </article>
</template>

<style scoped src="./ProjectAgentTaskCard.css"></style>
