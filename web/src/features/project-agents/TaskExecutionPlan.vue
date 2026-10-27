<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { getJson } from '@/api/client'
import { agentIdentitySwatch } from '@/features/agent-profile/agent-identity-color'
import { celebrateOnce } from '@/lib/celebration'
import { currentLocale, t } from '@/i18n'
import type { ProjectAgentTaskEvent, ProjectAgentTaskRecord } from '@/types'
import { normalizeTask } from './task-evidence'
import { statusTone } from './task-labels'
import { subscribeTaskUpdates } from './task-updates'

const props = withDefaults(defineProps<{
  task: ProjectAgentTaskRecord
  personalSpaceId: string
  active?: boolean
}>(), { active: true })
const snapshot = shallowRef(props.task)
const root = ref<HTMLElement | null>(null)
const stale = ref(false)
const visible = ref(!document.hidden)
watch(() => [props.task, props.personalSpaceId], () => {
  snapshot.value = props.task
  stale.value = false
})
const planEvent = computed(() => (snapshot.value.events ?? []).reduce<ProjectAgentTaskEvent | null>((latest, event) => {
  if (!event.executionPlan || (latest && event.createdAt < latest.createdAt)) return latest
  return event
}, null))
const steps = computed(() => planEvent.value?.executionPlan?.steps ?? [])
const updatedAt = computed(() => planEvent.value
  ? new Date(planEvent.value.createdAt).toLocaleString(currentLocale()) : '')

// Celebrate only a completion seen happening here, never one already done on load.
watch(() => [snapshot.value.taskId, snapshot.value.status] as const, ([taskId, status], previous) => {
  if (!previous || previous[0] !== taskId || status !== 'completed' || previous[1] === 'completed') return
  const swatch = agentIdentitySwatch(snapshot.value.leadAgentId)
  celebrateOnce(`task-completed:${taskId}`, root.value, swatch === null ? undefined : `--identity-${swatch}`)
})

function visibilityChanged() { visible.value = !document.hidden }
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', visibilityChanged))
watch([
  () => props.personalSpaceId, () => props.task.taskId, () => props.task.personalProjectId,
  () => props.active && visible.value && !['completed', 'failed', 'cancelled'].includes(snapshot.value.status),
], ([spaceId, taskId, projectId, active], _previous, cleanup) => {
  if (!active || !spaceId) return
  const controller = new AbortController()
  const query = new URLSearchParams({ personalSpaceId: spaceId })
  if (projectId) query.set('personalProjectId', projectId)
  let inFlight = false
  let pending = false
  async function refresh() {
    pending = true
    if (inFlight) return
    inFlight = true
    try {
      while (pending && !controller.signal.aborted) {
        pending = false
        try {
          const task = normalizeTask(await getJson(`/api/project-agent-tasks/${encodeURIComponent(taskId)}?${query}`, { signal: controller.signal }))
          if (!controller.signal.aborted && task?.taskId === taskId) {
            snapshot.value = task
            stale.value = false
          }
        } catch {
          if (!controller.signal.aborted) stale.value = true
        }
      }
    } finally { inFlight = false }
  }
  const unsubscribe = subscribeTaskUpdates(spaceId, { taskId, changed: () => void refresh(), unavailable: () => { stale.value = true } })
  cleanup(() => { unsubscribe(); controller.abort() })
}, { immediate: true })
</script>

<template>
  <section v-if="steps.length" ref="root" class="task-execution-plan" data-execution-plan :aria-label="t('projectAgents.executionPlan.title')">
    <div class="plan-heading">
      <strong>{{ t('projectAgents.executionPlan.title') }}</strong>
      <small>{{ t('projectAgents.executionPlan.reported') }}</small>
    </div>
    <ol class="plan-steps" aria-live="polite">
      <li v-for="step in steps" :key="step.id" :class="`is-${step.status}`" :data-tone="statusTone(step.status)" :aria-current="step.status === 'in_progress' ? 'step' : undefined">
        <div class="plan-step-heading">
          <span>{{ step.title }}</span>
          <small class="plan-step-status">{{ t(`projectAgents.executionPlan.status.${step.status}`) }}</small>
        </div>
        <p v-if="step.detail">{{ step.detail }}</p>
      </li>
    </ol>
    <p class="plan-updated">
      {{ t('projectAgents.executionPlan.updated') }} · <time :datetime="planEvent?.createdAt">{{ updatedAt }}</time>
      <span v-if="stale" role="status"> · {{ t('projectAgents.executionPlan.unavailable') }}</span>
    </p>
  </section>
</template>

<style scoped>
.task-execution-plan { grid-column: 1 / -1; min-width: 0; padding: 12px; background: var(--color-surface-subtle); border-radius: 8px; overflow-wrap: anywhere; }
.plan-heading, .plan-step-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.plan-heading strong { font-size: 13px; }
.plan-heading small, .plan-updated, .plan-steps p { color: var(--color-muted); font-size: 12px; }
.plan-steps { margin: 12px 0; padding-left: 24px; display: grid; gap: 12px; }
.plan-steps li { padding-left: 2px; font-size: 13px; line-height: 1.6; }
.plan-step-status { flex-shrink: 0; color: var(--color-muted); }
.plan-steps .is-in_progress { font-weight: 600; }
/* Colours come from the shared status tone (task-labels.ts statusTone). */
[data-tone="active"] .plan-step-status { color: var(--color-accent); }
[data-tone="success"] .plan-step-status { color: var(--color-success); }
[data-tone="warning"] .plan-step-status { color: var(--color-warning); }
[data-tone="danger"] .plan-step-status { color: var(--color-danger); }
.plan-steps p { margin: 3px 0 0; white-space: pre-wrap; font-weight: 400; }
.plan-updated { margin: 0; line-height: 1.5; }
@media (max-width: 540px) { .plan-heading { flex-wrap: wrap; } }
</style>
