<script setup lang="ts">
import { computed, ref } from 'vue'

import { apiErrorCode, apiErrorReason } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import UiNotice from '@/ui/UiNotice.vue'
import { decideAgentWorkflow, openWorkflows, type AgentWorkflow, type AgentWorkflowDecision, type AgentWorkflowVersion } from './agent-workflows'

// The workflows an Agent proposed and the ones the person confirmed (rec#60
// D-78). Only the person decides, here, on the version this list shows; the
// page reads the list again afterwards (`changed`).
const props = defineProps<{ workflows: AgentWorkflow[] }>()
const emit = defineEmits<{ changed: [] }>()

const shown = computed(() => openWorkflows(props.workflows))
const deciding = ref<{ workflowId: string; decision: AgentWorkflowDecision } | null>(null)
const notice = ref<{ tone: 'warning' | 'error'; text: string } | null>(null)
const PENDING_LABEL: Record<AgentWorkflowDecision, string> = {
  confirm: 'agentWorkbench.workflows.confirming',
  reject: 'agentWorkbench.workflows.rejecting',
  retire: 'agentWorkbench.workflows.retiring',
}

function displayed(workflow: AgentWorkflow) {
  return (workflow.pending ?? workflow.active)!
}
function stateLabel(workflow: AgentWorkflow) {
  if (!workflow.pending) return t('agentWorkbench.workflows.active')
  return t(workflow.active ? 'agentWorkbench.workflows.changeAwaiting' : 'agentWorkbench.workflows.awaiting')
}
function sourceLabel(version: AgentWorkflowVersion) {
  if (version.source.startsWith('candidate:')) return t('agentWorkbench.workflows.fromCandidate')
  return t(version.createdBy === 'person' ? 'agentWorkbench.workflows.fromPerson' : 'agentWorkbench.workflows.fromAgent')
}
function when(value: string) {
  return formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '' })
}
function isDeciding(workflow: AgentWorkflow, decision: AgentWorkflowDecision) {
  return deciding.value?.workflowId === workflow.workflowId && deciding.value.decision === decision
}

async function decide(workflow: AgentWorkflow, decision: AgentWorkflowDecision) {
  const version = decision === 'retire' ? workflow.active?.version : workflow.pending?.version
  if (!version || deciding.value) return
  deciding.value = { workflowId: workflow.workflowId, decision }
  notice.value = null
  try {
    await decideAgentWorkflow(workflow.workflowId, decision, version)
  } catch (error) {
    notice.value = apiErrorCode(error) === 'version_conflict'
      ? { tone: 'warning', text: t('agentWorkbench.workflows.changed') }
      : { tone: 'error', text: t('agentWorkbench.workflows.failed', { reason: apiErrorReason(error) }) }
  } finally {
    deciding.value = null
    emit('changed')
  }
}
</script>

<template>
  <section class="agent-workflows" aria-labelledby="agent-workflows-heading">
    <div class="agent-section-heading">
      <h2 id="agent-workflows-heading">{{ t('agentWorkbench.workflows.title') }}</h2>
      <span v-if="shown.length">{{ shown.length }}</span>
    </div>
    <UiNotice v-if="notice" :tone="notice.tone" data-workflow-notice>{{ notice.text }}</UiNotice>
    <p v-if="!shown.length" class="agent-muted">{{ t('agentWorkbench.workflows.none') }}</p>
    <ul v-else class="agent-workflow-list">
      <li v-for="workflow in shown" :key="workflow.workflowId" class="agent-workflow" :data-workflow="workflow.workflowId" :data-workflow-state="workflow.pending ? 'awaiting' : 'active'">
        <header class="agent-workflow-header">
          <h3>{{ displayed(workflow).name }}</h3>
          <Badge :variant="workflow.pending ? 'warning' : 'success'">{{ stateLabel(workflow) }}</Badge>
        </header>
        <p class="agent-workflow-purpose">{{ displayed(workflow).purpose }}</p>

        <template v-if="workflow.active">
          <h4 v-if="workflow.pending">{{ t('agentWorkbench.workflows.current') }}</h4>
          <ol class="agent-workflow-steps" data-workflow-steps="active">
            <li v-for="(step, index) in workflow.active.steps" :key="index">
              <strong>{{ step.title }}</strong>
              <span v-if="step.detail">{{ step.detail }}</span>
            </li>
          </ol>
        </template>
        <template v-if="workflow.pending">
          <h4 v-if="workflow.active">{{ t('agentWorkbench.workflows.proposedChange', { version: workflow.pending.version }) }}</h4>
          <ol class="agent-workflow-steps" data-workflow-steps="pending">
            <li v-for="(step, index) in workflow.pending.steps" :key="index">
              <strong>{{ step.title }}</strong>
              <span v-if="step.detail">{{ step.detail }}</span>
            </li>
          </ol>
        </template>

        <p class="agent-workflow-meta">
          {{ t('agentWorkbench.workflows.version', { version: displayed(workflow).version, count: workflow.versionCount }) }}
          · {{ sourceLabel(displayed(workflow)) }}
        </p>

        <div v-if="workflow.active" class="agent-workflow-runs">
          <h4>{{ t('agentWorkbench.workflows.runs') }}</h4>
          <ul v-if="workflow.recentRuns.length">
            <li v-for="run in workflow.recentRuns" :key="run.runId">
              <Badge :variant="run.outcome === 'done' ? 'success' : run.outcome === 'failed' ? 'destructive' : 'secondary'">
                {{ t(`agentWorkbench.workflows.outcome.${run.outcome}`) }}
              </Badge>
              <time :datetime="run.recordedAt">{{ when(run.recordedAt) }}</time>
              <span v-if="run.note" class="agent-workflow-run-note">{{ run.note }}</span>
            </li>
          </ul>
          <p v-else class="agent-muted">{{ t('agentWorkbench.workflows.noRuns') }}</p>
        </div>

        <div class="agent-workflow-actions">
          <template v-if="workflow.pending">
            <Button size="sm" :loading="isDeciding(workflow, 'confirm')" :loading-label="t(PENDING_LABEL.confirm, { name: workflow.pending.name })"
              :disabled="Boolean(deciding)" data-workflow-action="confirm" @click="decide(workflow, 'confirm')">
              {{ t('agentWorkbench.workflows.confirm') }}
            </Button>
            <Button size="sm" variant="outline" :loading="isDeciding(workflow, 'reject')" :loading-label="t(PENDING_LABEL.reject, { name: workflow.pending.name })"
              :disabled="Boolean(deciding)" data-workflow-action="reject" @click="decide(workflow, 'reject')">
              {{ t('agentWorkbench.workflows.reject') }}
            </Button>
          </template>
          <Button v-else size="sm" variant="ghost" :loading="isDeciding(workflow, 'retire')" :loading-label="t(PENDING_LABEL.retire, { name: displayed(workflow).name })"
            :disabled="Boolean(deciding)" data-workflow-action="retire" @click="decide(workflow, 'retire')">
            {{ t('agentWorkbench.workflows.retire') }}
          </Button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agent-workflows { display: grid; gap: var(--space-3, 12px); min-width: 0; }
.agent-workflows .agent-section-heading { margin-bottom: 0; }
.agent-workflow-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: var(--space-4, 16px); margin: 0; padding: 0; list-style: none; }
/* Each workflow is its own lifted card; one waiting for the person carries a warning badge, never a side bar. */
.agent-workflow { display: grid; align-content: start; gap: var(--space-2, 8px); min-width: 0; padding: var(--space-4, 16px); border-radius: var(--radius-card, 12px); background: var(--color-surface); box-shadow: var(--shadow-sm); }
.agent-workflow-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2, 8px); min-width: 0; }
.agent-workflow-header h3 { margin: 0; font-size: var(--text-card-title, 15px); font-weight: 600; overflow-wrap: anywhere; }
.agent-workflow-purpose { margin: 0; color: var(--color-muted); font-size: var(--text-body, 14px); overflow-wrap: anywhere; }
.agent-workflow h4 { margin: var(--space-2, 8px) 0 0; color: var(--color-muted); font-size: var(--text-meta, 12px); font-weight: 500; }
.agent-workflow-steps { display: grid; gap: 6px; margin: 0; padding-left: 1.4em; font-size: var(--text-body, 14px); list-style: decimal; }
.agent-workflow-steps li { gap: 2px; overflow-wrap: anywhere; }
.agent-workflow-steps li::marker { color: var(--color-muted); font-size: var(--text-meta, 12px); }
.agent-workflow-steps span { display: block; }
.agent-workflow-steps strong { font-weight: 500; }
.agent-workflow-steps span { color: var(--color-muted); font-size: var(--text-meta, 12px); }
.agent-workflow-meta { margin: 0; color: var(--color-muted); font-size: var(--text-meta, 12px); }
.agent-workflow-runs ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: var(--text-meta, 12px); }
.agent-workflow-runs li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.agent-workflow-runs time { color: var(--color-muted); }
.agent-workflow-run-note { min-width: 0; overflow-wrap: anywhere; }
.agent-workflow-actions { display: flex; flex-wrap: wrap; gap: var(--space-2, 8px); margin-top: var(--space-2, 8px); }
</style>
