<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import type { ProjectAgentTaskRecord } from '@/types'
import { Button } from '@/components/ui/button'
import UiDialog from '@/ui/UiDialog.vue'
import { formatDate, taskStatusLabel } from './task-labels'
import {
  actionFailure, mergeRunPages, readTaskRuns, retryTask, runIsActive, runOutcomeUncertain, stopTaskRun, taskIsRetryable,
  type ActionFailure, type TaskRunRecord, type TaskScope,
} from './task-runs'
import { forgetRetryOutcome, keepRetryOutcome, retryOutcome } from './retry-outcomes'

const props = defineProps<{ task: ProjectAgentTaskRecord; personalSpaceId: string; active: boolean }>()
const emit = defineEmits<{ changed: [] }>()

const scope = computed<TaskScope | null>(() => props.task.personalProjectId
  ? { personalSpaceId: props.personalSpaceId, personalProjectId: props.task.personalProjectId, taskId: props.task.taskId }
  : null)

const runs = ref<TaskRunRecord[]>([])
const nextCursor = ref<string | null>(null)
const complete = ref(false)
const loaded = ref(false)
const loading = ref(false)
const historyError = ref(false)
// Each read belongs to one task; a late page for an earlier task is dropped.
let readGeneration = 0

async function readPage(cursor: string | null) {
  if (!scope.value) return
  const generation = cursor ? readGeneration : ++readGeneration
  loading.value = true
  historyError.value = false
  try {
    const page = await readTaskRuns(scope.value, cursor)
    if (generation !== readGeneration) return
    // A response without a run list is a protocol error, not an empty history.
    if (!Array.isArray(page?.runs)) { historyError.value = true; return }
    runs.value = cursor ? mergeRunPages(runs.value, page.runs) : page.runs
    // A repeated or missing cursor would loop; stop and mark the read incomplete.
    nextCursor.value = page.nextCursor && page.nextCursor !== cursor ? page.nextCursor : null
    complete.value = page.complete
    loaded.value = true
  } catch (error) {
    if (generation !== readGeneration) return
    if (actionFailure(error) === 'denied') { revoke(); return }
    historyError.value = true
  } finally {
    if (generation === readGeneration) loading.value = false
  }
}

const reload = () => readPage(null)
watch(() => [props.active, props.task.taskId] as const, ([active], previous) => {
  if (previous && previous[1] !== props.task.taskId) { readGeneration += 1; runs.value = []; loaded.value = false }
  if (active && !loaded.value && !loading.value) void reload()
}, { immediate: true })

const activeRuns = computed(() => runs.value.filter(runIsActive))
const retryable = computed(() => taskIsRetryable(props.task.status) && Boolean(scope.value))
// A history that could not be read in full cannot prove the earlier runs were
// harmless, so it counts as uncertain until it is read completely.
const historyIncomplete = computed(() => !loaded.value || loading.value || historyError.value || !complete.value)
const uncertain = computed(() => historyIncomplete.value || runs.value.some(runOutcomeUncertain))

// Lost access clears what this panel showed and closes its dialogs; a late
// response from before cannot bring them back.
function revoke() {
  readGeneration += 1
  loading.value = false
  runs.value = []
  loaded.value = false
  complete.value = false
  nextCursor.value = null
  stopTarget.value = null
  retryOpen.value = false
  forgetRetryOutcome(props.personalSpaceId, props.task.taskId)
  notice.value = t('taskRuns.failure.denied')
}

// Stop: one explicit run per confirmation.
const stopTarget = ref<TaskRunRecord | null>(null)
const stopBusy = ref(false)
const stopError = ref('')
const notice = ref('')
async function confirmStop() {
  if (!scope.value || !stopTarget.value) return
  stopBusy.value = true
  stopError.value = ''
  try {
    const response = await stopTaskRun(scope.value, stopTarget.value.runId)
    notice.value = response.status === 'stopping' ? t('taskRuns.stopped') : t('taskRuns.alreadyStopped')
    stopTarget.value = null
    await reload()
  } catch (error) {
    if (actionFailure(error) === 'denied') { revoke(); return }
    stopError.value = failureText(actionFailure(error), error)
  } finally {
    stopBusy.value = false
  }
}

// Retry: the person chooses how the new task starts; nothing is preselected.
const retryOpen = ref(false)
const retryStart = ref<'queue' | 'backlog' | ''>('')
const retryAck = ref(false)
const retryBusy = ref(false)
const retryError = ref('')
// Kept outside this panel: the refresh after a retry redraws it.
const retried = computed(() => retryOutcome(props.personalSpaceId, props.task.taskId))
// After an unconfirmed result the choice is frozen: the same request may be
// sent once more to confirm it (the server keys it by the original task); a
// second unconfirmed result leaves only reading the history.
const retryUnknown = ref<{ start: 'queue' | 'backlog'; resent: boolean } | null>(null)
const retrySlow = ref(false)
const canSubmitRetry = computed(() => retryUnknown.value
  ? !retryUnknown.value.resent
  : Boolean(retryStart.value) && (!uncertain.value || retryAck.value))
const SLOW_MS = 8_000
const GIVE_UP_MS = 30_000
let retryTimers: ReturnType<typeof setTimeout>[] = []
function clearRetryTimers() { retryTimers.forEach(clearTimeout); retryTimers = [] }
onBeforeUnmount(clearRetryTimers)
async function openRetry() {
  retryStart.value = retryUnknown.value?.start ?? ''
  retryAck.value = false
  retryError.value = retryUnknown.value ? t('taskRuns.failure.unknown') : ''
  retryOpen.value = true
  if (!loaded.value) await reload()
}
async function confirmRetry() {
  if (!scope.value || !canSubmitRetry.value || retryBusy.value) return
  const start = retryUnknown.value?.start ?? (retryStart.value as 'queue' | 'backlog')
  const resend = Boolean(retryUnknown.value)
  const controller = new AbortController()
  retryBusy.value = true
  retrySlow.value = false
  retryError.value = ''
  retryTimers = [setTimeout(() => { retrySlow.value = true }, SLOW_MS), setTimeout(() => controller.abort(), GIVE_UP_MS)]
  try {
    keepRetryOutcome(props.personalSpaceId, props.task.taskId, await retryTask(scope.value, start === 'queue', controller.signal))
    retryUnknown.value = null
    retryOpen.value = false
    emit('changed')
  } catch (error) {
    const kind = actionFailure(error)
    if (kind === 'denied') { revoke(); return }
    if (kind === 'unknown') retryUnknown.value = { start, resent: resend }
    retryError.value = failureText(kind, error)
  } finally {
    clearRetryTimers()
    retryBusy.value = false
    retrySlow.value = false
  }
}

const newTaskHref = computed(() => {
  const task = retried.value?.task
  const agentId = retried.value?.assignedAgent?.agentId ?? task?.leadAgentId
  if (!task || !agentId || !props.task.personalProjectId) return null
  return `/project-agents/manage?${new URLSearchParams({ agent: agentId, project: props.task.personalProjectId, task: task.taskId })}`
})

function failureText(kind: ActionFailure, error: unknown) {
  return kind === 'rejected'
    ? t('taskRuns.failure.rejected', { message: error instanceof Error ? error.message : '' })
    : t(`taskRuns.failure.${kind}`)
}
function stateLabel(state: string) {
  const key = `taskRuns.state.${state}`
  const label = t(key)
  return label === key ? state : label
}
</script>

<template>
  <section v-if="scope" class="task-run-controls" :aria-label="t('taskRuns.history')">
    <div class="task-run-actions">
      <Button v-for="run in activeRuns" :key="`stop-${run.runId}`" size="sm" variant="destructive" @click="stopTarget = run; stopError = ''">
        {{ t('taskRuns.stop') }}<span class="task-run-short-id">#{{ run.runId.slice(0, 8) }}</span>
      </Button>
      <Button variant="outline" v-if="retryable" size="sm" @click="openRetry">{{ t('taskRuns.retry') }}</Button>
    </div>
    <p v-if="notice" role="status" class="task-run-notice">{{ notice }}</p>
    <p v-if="retried" role="status" class="task-run-notice">
      {{ t('taskRuns.retried', { status: taskStatusLabel(retried.task.status) }) }}
      <RouterLink v-if="newTaskHref" :to="newTaskHref">{{ t('taskRuns.viewNew') }}</RouterLink>
      <code v-else>{{ retried.task.taskId }}</code>
    </p>
    <p v-if="retried?.mustDiscloseRecruitment && retried.clientNotice" role="note" class="task-run-risk" data-task-run-disclosure>{{ retried.clientNotice }}</p>

    <div class="project-agent-section-heading">
      <h5>{{ t('taskRuns.history') }}</h5>
      <span v-if="loaded">{{ t('taskRuns.loaded', { count: runs.length }) }} · {{ complete ? t('taskRuns.complete') : t('taskRuns.more') }}</span>
    </div>
    <GrowthLoading v-if="loading && !runs.length" variant="compact" :label="t('taskRuns.loadingHistory')" />
    <p v-else-if="historyError && !runs.length" role="alert" class="inline-error">
      {{ t('taskRuns.historyFailed') }} <Button size="sm" variant="ghost" @click="reload">{{ t('taskRuns.retryRead') }}</Button>
    </p>
    <p v-else-if="loaded && !runs.length" class="project-agent-muted">{{ t('taskRuns.empty') }}</p>
    <ol v-if="runs.length" class="task-run-list">
      <li v-for="(run, index) in runs" :key="run.runId" class="task-run-item">
        <header>
          <strong>{{ t('taskRuns.attempt', { count: run.attemptNumber ?? index + 1 }) }}</strong>
          <small>{{ formatDate(run.createdAt) }}</small>
          <i class="ui-badge" :class="`is-${run.state}`">{{ stateLabel(run.state) }}</i>
        </header>
        <dl class="project-agent-execution-summary-meta">
          <div><dt>{{ t('taskRuns.agent') }}</dt><dd>{{ run.agentId }}</dd></div>
          <div><dt>{{ t('taskRuns.executor') }}</dt><dd>{{ run.executorId || run.targetApplication || '—' }}</dd></div>
          <div><dt>{{ t('taskRuns.result') }}</dt><dd>{{ run.executionResult?.status || run.executionStatus }}<template v-if="run.executionResult?.failureClass"> · {{ run.executionResult.failureClass }}</template></dd></div>
          <div><dt>{{ t('taskRuns.authority') }}</dt><dd>{{ run.executionResult?.processStopped === true ? t('taskRuns.processStopped') : t('taskRuns.processNotReported') }}</dd></div>
        </dl>
        <p v-if="run.executionResult?.cleanupErrors?.length" class="inline-error">{{ t('taskRuns.cleanupErrors') }} · {{ run.executionResult.cleanupErrors.join(' · ') }}</p>
        <details class="project-agent-task-tech" data-task-run-evidence>
          <summary>{{ t('taskRuns.evidence') }}</summary>
          <dl class="project-agent-execution-summary-meta">
            <div><dt>{{ t('taskRuns.runId') }}</dt><dd>{{ run.runId }}</dd></div>
            <div v-if="run.rootRunId || run.retryOfRunId"><dt>{{ t('taskRuns.retryChain') }}</dt><dd>{{ run.rootRunId ?? '—' }} → {{ run.retryOfRunId ?? '—' }}</dd></div>
            <div><dt>{{ t('taskRuns.requestedModel') }}</dt><dd>{{ [run.requestedModelProvider, run.requestedModel].filter(Boolean).join(' · ') || '—' }}</dd></div>
            <div><dt>{{ t('taskRuns.actualSession') }}</dt><dd>{{ run.actualSessionId || t('taskRuns.notReported') }}</dd></div>
            <div><dt>{{ t('taskRuns.dispatchedAt') }}</dt><dd>{{ run.promptDispatchedAt ? formatDate(run.promptDispatchedAt) : t('taskRuns.notReported') }}</dd></div>
            <div><dt>{{ t('taskRuns.closedAt') }}</dt><dd>{{ run.closedAt ? formatDate(run.closedAt) : '—' }}<template v-if="run.closeReason"> · {{ run.closeReason }}</template></dd></div>
          </dl>
          <!-- The whole record as served, unknown fields included, for checking and copying. -->
          <pre class="task-run-evidence" tabindex="0">{{ JSON.stringify(run, null, 2) }}</pre>
        </details>
      </li>
    </ol>
    <p v-if="historyError && runs.length" role="alert" class="inline-error">{{ t('taskRuns.historyFailed') }}</p>
    <Button v-if="nextCursor && !complete" size="sm" variant="ghost" :loading="loading" :loading-label="t('taskRuns.loadingMore')" @click="readPage(nextCursor)">
      {{ t('taskRuns.loadMore') }}
    </Button>

    <UiDialog :open="Boolean(stopTarget)" :title="t('taskRuns.stopTitle')" size="sm" :busy="stopBusy" :error="stopError" @close="stopTarget = null">
      <p>{{ task.title }} · {{ stopTarget?.agentId }} · #{{ stopTarget?.runId.slice(0, 8) }}</p>
      <p>{{ t('taskRuns.stopBody') }}</p>
      <template #footer>
        <Button variant="outline" :disabled="stopBusy" @click="stopTarget = null">{{ t('common.actions.cancel') }}</Button>
        <Button variant="destructive" :loading="stopBusy" :loading-label="t('taskRuns.stopping')" @click="confirmStop">{{ t('taskRuns.stopConfirm') }}</Button>
      </template>
    </UiDialog>

    <UiDialog :open="retryOpen" :title="t('taskRuns.retryTitle')" :busy="retryBusy" :error="retryError" form @close="retryOpen = false" @submit="confirmRetry">
      <p>{{ t('taskRuns.retryBody') }}</p>
      <fieldset class="task-run-choices" :disabled="retryBusy || Boolean(retryUnknown)">
        <legend>{{ t('taskRuns.retryChoose') }}</legend>
        <label><input v-model="retryStart" type="radio" name="retry-start" value="queue" /> {{ t('taskRuns.retryQueue') }}</label>
        <label><input v-model="retryStart" type="radio" name="retry-start" value="backlog" /> {{ t('taskRuns.retryBacklog') }}</label>
      </fieldset>
      <p v-if="retrySlow" role="status" class="task-run-notice">{{ t('taskRuns.retrySlow') }}</p>
      <p v-if="retryUnknown?.resent" role="alert" class="task-run-risk">{{ t('taskRuns.retryStillUnknown') }}</p>
      <template v-if="uncertain && !retryUnknown">
        <p role="note" class="task-run-risk">{{ t('taskRuns.retryRisk') }}</p>
        <label class="task-run-ack"><input v-model="retryAck" type="checkbox" :disabled="retryBusy" /> {{ t('taskRuns.retryAck') }}</label>
      </template>
      <template #footer>
        <Button variant="outline" :disabled="retryBusy" @click="retryOpen = false">{{ t('common.actions.cancel') }}</Button>
        <Button variant="outline" v-if="retryUnknown" :disabled="retryBusy" @click="reload">{{ t('taskRuns.retryRead') }}</Button>
        <Button type="submit" :disabled="!canSubmitRetry" :loading="retryBusy" :loading-label="t('taskRuns.retrying')">
          {{ retryUnknown ? t('taskRuns.retryConfirmOnce') : t('taskRuns.retrySubmit') }}
        </Button>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.task-run-controls { display: grid; gap: 8px; margin-top: 12px; }
.task-run-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.task-run-short-id { margin-left: 4px; font-variant-numeric: tabular-nums; opacity: .75; }
.task-run-notice { margin: 0; font-size: 13px; }
.task-run-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.task-run-item { padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 10px; }
.task-run-item header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.task-run-item header i { margin-left: auto; }
.task-run-evidence { overflow-x: auto; max-height: 240px; margin: 4px 0 0; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.task-run-choices { display: grid; gap: 6px; margin: 12px 0; padding: 0; border: 0; }
.task-run-choices label, .task-run-ack { display: flex; gap: 8px; align-items: center; min-height: 32px; }
.task-run-risk { margin: 8px 0 4px; color: var(--color-warning); }
</style>
