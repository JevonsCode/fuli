<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'

import { judgmentText } from './judgment-copy'
import { loadJudgmentRecords, requestJudgmentReview, submitJudgmentFeedback } from './judgment-api'
import { isHumanNeeded, type JudgmentDecisionRecord, type JudgmentFeedbackVote } from './judgment-types'

const props = defineProps<{ personalSpaceId: string }>()

const records = ref<JudgmentDecisionRecord[]>([])
const loading = ref(false)
const error = ref('')
const reviewError = ref('')
const filter = ref<'all' | 'human'>('human')
const reviewing = ref(false)
const feedbackSavingId = ref<string | null>(null)
const feedbackReasons = ref<Record<string, string>>({})
const feedbackReasonDirty = ref<Set<string>>(new Set())
let scopeGeneration = 0
let loadGeneration = 0
let reviewGeneration = 0
let feedbackGeneration = 0

const visibleRecords = computed(() => {
  const source = filter.value === 'human' ? records.value.filter(isHumanNeeded) : records.value
  return [...source].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
})
const busy = computed(() => loading.value || reviewing.value)

watch(() => props.personalSpaceId, (scope) => {
  scopeGeneration += 1
  reviewGeneration += 1
  feedbackGeneration += 1
  records.value = []
  feedbackReasons.value = {}
  feedbackReasonDirty.value = new Set()
  error.value = ''
  reviewError.value = ''
  reviewing.value = false
  feedbackSavingId.value = null
  void load(scope)
}, { immediate: true })

function isCurrentScope(scope: string, current: number) {
  return props.personalSpaceId === scope && scopeGeneration === current
}

function applyRecords(next: JudgmentDecisionRecord[]) {
  const reasons: Record<string, string> = {}
  for (const record of next) {
    reasons[record.id] = feedbackReasonDirty.value.has(record.id)
      ? feedbackReasons.value[record.id] ?? ''
      : record.feedback?.reason ?? ''
  }
  records.value = next
  feedbackReasons.value = reasons
}

async function load(scopeInput?: unknown) {
  const scope = typeof scopeInput === 'string' ? scopeInput : props.personalSpaceId
  const current = scopeGeneration
  const requestGeneration = ++loadGeneration
  error.value = ''
  if (!scope || !isCurrentScope(scope, current)) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const result = await loadJudgmentRecords(scope)
    if (isCurrentScope(scope, current) && requestGeneration === loadGeneration) {
      applyRecords(Array.isArray(result.records) ? result.records : [])
    }
  } catch (cause) {
    if (isCurrentScope(scope, current) && requestGeneration === loadGeneration) {
      error.value = cause instanceof Error ? cause.message : judgmentText('workbench.loadError')
    }
  } finally {
    if (isCurrentScope(scope, current) && requestGeneration === loadGeneration) loading.value = false
  }
}

async function review() {
  if (!props.personalSpaceId || reviewing.value) return
  const scope = props.personalSpaceId
  const current = scopeGeneration
  const requestGeneration = ++reviewGeneration
  reviewing.value = true
  reviewError.value = ''
  try {
    const result = await requestJudgmentReview(scope, undefined, 10)
    if (!isCurrentScope(scope, current) || requestGeneration !== reviewGeneration) return
    const next = new Map(records.value.map(record => [record.id, record]))
    for (const record of result.records ?? []) next.set(record.id, record)
    applyRecords([...next.values()])
  } catch (cause) {
    if (isCurrentScope(scope, current) && requestGeneration === reviewGeneration) {
      reviewError.value = cause instanceof Error ? cause.message : judgmentText('workbench.reviewError')
    }
  } finally {
    if (isCurrentScope(scope, current) && requestGeneration === reviewGeneration) reviewing.value = false
  }
}

function statusCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'status' in cause && typeof (cause as { status?: unknown }).status === 'number'
    ? (cause as { status: number }).status
    : null
}

function feedbackReason(record: JudgmentDecisionRecord) {
  return (feedbackReasons.value[record.id] ?? record.feedback?.reason ?? '').trim().slice(0, 1000)
}

function markReasonEdited(recordId: string) {
  const next = new Set(feedbackReasonDirty.value)
  next.add(recordId)
  feedbackReasonDirty.value = next
}

function replaceFeedback(updated: JudgmentDecisionRecord) {
  const index = records.value.findIndex(candidate => candidate.id === updated.id)
  if (index >= 0) records.value.splice(index, 1, updated)
  const next = new Set(feedbackReasonDirty.value)
  next.delete(updated.id)
  feedbackReasonDirty.value = next
  feedbackReasons.value = { ...feedbackReasons.value, [updated.id]: updated.feedback?.reason ?? '' }
}

async function persistFeedback(record: JudgmentDecisionRecord, nextVote: JudgmentFeedbackVote) {
  if (feedbackSavingId.value) return
  const scope = props.personalSpaceId
  const current = scopeGeneration
  const requestGeneration = ++feedbackGeneration
  if (!scope || !isCurrentScope(scope, current)) return
  feedbackSavingId.value = record.id
  error.value = ''
  try {
    const updated = await submitJudgmentFeedback(
      scope,
      record.id,
      nextVote,
      feedbackReason(record),
      record.feedback.revision,
    )
    if (isCurrentScope(scope, current) && requestGeneration === feedbackGeneration) replaceFeedback(updated)
  } catch (cause) {
    if (!isCurrentScope(scope, current) || requestGeneration !== feedbackGeneration) return
    if (statusCode(cause) === 409) {
      await load(scope)
      if (isCurrentScope(scope, current)) error.value = judgmentText('workbench.feedbackConflict')
    } else error.value = cause instanceof Error ? cause.message : judgmentText('workbench.reviewError')
  } finally {
    if (isCurrentScope(scope, current) && requestGeneration === feedbackGeneration) feedbackSavingId.value = null
  }
}

function feedback(record: JudgmentDecisionRecord, vote: Exclude<JudgmentFeedbackVote, null>) {
  const nextVote: JudgmentFeedbackVote = record.feedback.vote === vote ? null : vote
  void persistFeedback(record, nextVote)
}

function saveReason(record: JudgmentDecisionRecord) {
  void persistFeedback(record, record.feedback.vote)
}

function dateLabel(value: string) {
  if (!value || Number.isNaN(Date.parse(value))) return judgmentText('workbench.timeUnknown')
  return new Date(value).toLocaleString()
}

function outcomeLabel(value: JudgmentDecisionRecord['outcome']) {
  return judgmentText(`workbench.outcome.${value}`)
}

function executionLabel(value: JudgmentDecisionRecord['execution']['status']) {
  return judgmentText(`workbench.executionStatus.${value}`)
}

function kindLabel(value: JudgmentDecisionRecord['kind']) {
  return judgmentText(`workbench.kind.${value}`)
}

function policyLabel(record: JudgmentDecisionRecord) {
  if (!record.policy) return '—'
  return [
    record.policy.mode ? judgmentText(`mode.${record.policy.mode}`) : '',
    record.policy.quality ? judgmentText(`quality.${record.policy.quality}`) : '',
    record.policy.client ? judgmentText(`client.${record.policy.client}`) : '',
  ].filter(Boolean).join(' · ')
}

function clientLabel(client?: string | null) {
  return client === 'codex' || client === 'claude_code' ? judgmentText(`client.${client}`) : client || ''
}

function sourceLabel(record: JudgmentDecisionRecord) {
  return [clientLabel(record.client), record.model || ''].filter(Boolean).join(' · ')
}

function selectionLabel(record: JudgmentDecisionRecord) {
  if (!record.selection) return ''
  return [record.selection.executorId, record.selection.model, clientLabel(record.selection.client)].filter(Boolean).join(' · ')
}

function detailText(value: unknown, limit = 4000) {
  if (typeof value === 'string') return value.slice(0, limit)
  if (value === null || value === undefined) return ''
  try {
    const serialized = JSON.stringify(value, null, 2)
    return typeof serialized === 'string' ? serialized.slice(0, limit) : ''
  } catch {
    return judgmentText('workbench.detailsUnavailable')
  }
}

function receiptReason(record: JudgmentDecisionRecord) {
  const receipt = record.execution?.receipt
  if (!receipt || typeof receipt !== 'object') return ''
  const reason = (receipt as Record<string, unknown>).reason
  return typeof reason === 'string' ? reason : ''
}

function hasDetails(record: JudgmentDecisionRecord) {
  return Boolean(
    record.sessionId
    || record.error
    || record.execution?.receipt
    || record.feedbackHistory?.length
    || record.executionHistory?.length,
  )
}
</script>

<template>
  <section class="judgment-workbench" :aria-label="judgmentText('workbench.aria')">
    <header class="judgment-workbench-heading">
      <div>
        <h2>{{ judgmentText('workbench.title') }}</h2>
        <p>{{ judgmentText('workbench.subtitle') }}</p>
      </div>
      <div class="judgment-workbench-actions">
        <GrowthLoading v-if="reviewing" variant="inline" :label="judgmentText('workbench.reviewing')" />
        <button class="quiet-button" type="button" :disabled="busy" @click="load">{{ judgmentText('workbench.refresh') }}</button>
        <button class="ui-button ui-button--primary" type="button" data-action="review" :disabled="busy || !props.personalSpaceId" @click="review">
          {{ judgmentText('workbench.review') }}
        </button>
      </div>
    </header>

    <GrowthLoading v-if="loading && !records.length" variant="compact" :label="judgmentText('workbench.loading')" />
    <GrowthLoading v-else-if="loading" variant="inline" :label="judgmentText('workbench.loading')" />
    <div v-if="error" class="judgment-workbench-error" role="alert">
      <span>{{ error }}</span>
      <button class="quiet-button" type="button" :disabled="busy" @click="load">{{ judgmentText('workbench.retry') }}</button>
    </div>
    <div v-if="reviewError" class="judgment-workbench-error" role="alert">{{ reviewError }}</div>

    <div class="judgment-filter" role="group" :aria-label="judgmentText('workbench.title')">
      <button type="button" data-filter="human" :aria-pressed="filter === 'human'" @click="filter = 'human'">{{ judgmentText('workbench.human') }}</button>
      <button type="button" data-filter="all" :aria-pressed="filter === 'all'" @click="filter = 'all'">{{ judgmentText('workbench.all') }}</button>
    </div>

    <div v-if="!loading && !error && !visibleRecords.length" class="judgment-workbench-empty">
      {{ judgmentText(filter === 'human' ? 'workbench.emptyHuman' : 'workbench.empty') }}
    </div>
    <div v-else class="judgment-record-list">
      <article v-for="record in visibleRecords" :key="record.id" data-decision-card class="judgment-record-card" :class="{ 'is-human-needed': isHumanNeeded(record) }">
        <header class="judgment-record-heading">
          <div>
            <span class="judgment-record-kind">{{ kindLabel(record.kind) }}</span>
            <h3>{{ record.target }}</h3>
          </div>
          <span class="judgment-outcome" :class="`is-${record.outcome}`">{{ outcomeLabel(record.outcome) }}</span>
        </header>
        <p class="judgment-record-summary">{{ record.summary }}</p>
        <dl class="judgment-record-meta">
          <div><dt>{{ judgmentText('workbench.execution') }}</dt><dd>{{ executionLabel(record.execution.status) }}</dd></div>
          <div><dt>{{ judgmentText('workbench.policy') }}</dt><dd>{{ policyLabel(record) }}</dd></div>
          <div v-if="record.client || record.model"><dt>{{ judgmentText('workbench.source') }}</dt><dd>{{ sourceLabel(record) }}</dd></div>
          <div v-if="record.disposition"><dt>{{ judgmentText('workbench.disposition') }}</dt><dd>{{ judgmentText(`workbench.actions.${record.disposition}`) }}</dd></div>
          <div v-if="record.selection"><dt>{{ judgmentText('workbench.selection') }}</dt><dd>{{ selectionLabel(record) }}</dd></div>
          <div><dt> </dt><dd>{{ dateLabel(record.createdAt) }}</dd></div>
        </dl>
        <section v-if="record.evidence.length" class="judgment-record-evidence">
          <h4>{{ judgmentText('workbench.evidence') }}</h4>
          <ul><li v-for="evidence in record.evidence" :key="evidence">{{ evidence }}</li></ul>
        </section>
        <details v-if="hasDetails(record)" class="judgment-record-details" data-judgment-details>
          <summary>{{ judgmentText('workbench.details') }}</summary>
          <dl class="judgment-record-detail-list">
            <div v-if="record.sessionId"><dt>{{ judgmentText('workbench.session') }}</dt><dd><code>{{ record.sessionId }}</code></dd></div>
            <div v-if="record.error"><dt>{{ judgmentText('workbench.recordError') }}</dt><dd>{{ detailText(record.error, 1000) }}</dd></div>
          </dl>
          <section v-if="record.execution.receipt" class="judgment-record-detail-block">
            <h4>{{ judgmentText('workbench.receipt') }}</h4>
            <p v-if="receiptReason(record)">{{ receiptReason(record) }}</p>
            <pre>{{ detailText(record.execution.receipt, 3000) }}</pre>
          </section>
          <section v-if="record.feedbackHistory?.length" class="judgment-record-detail-block">
            <h4>{{ judgmentText('workbench.feedbackHistory') }}</h4>
            <pre v-for="(entry, index) in record.feedbackHistory.slice(-5)" :key="`${index}-${detailText(entry, 200)}`">{{ detailText(entry, 1200) }}</pre>
          </section>
          <section v-if="record.executionHistory?.length" class="judgment-record-detail-block">
            <h4>{{ judgmentText('workbench.executionHistory') }}</h4>
            <pre v-for="(entry, index) in record.executionHistory.slice(-5)" :key="`${index}-${detailText(entry, 200)}`">{{ detailText(entry, 1200) }}</pre>
          </section>
        </details>
        <section class="judgment-record-feedback" :aria-label="judgmentText('workbench.feedback')">
          <details class="judgment-feedback-editor" data-feedback-editor>
            <summary data-feedback-toggle>{{ feedbackReasons[record.id] ? judgmentText('workbench.feedbackReasonSaved') : judgmentText('workbench.feedbackReasonAdd') }}</summary>
            <div class="judgment-feedback-editor-row">
              <label class="visually-hidden" :for="`judgment-feedback-${record.id}`">{{ judgmentText('workbench.feedbackReason') }}</label>
              <textarea :id="`judgment-feedback-${record.id}`" v-model="feedbackReasons[record.id]" data-feedback-reason rows="2" maxlength="1000" :disabled="feedbackSavingId === record.id" @input="markReasonEdited(record.id)" @keydown.enter.exact.prevent="saveReason(record)" />
              <button class="judgment-save-reason" type="button" data-save-reason :aria-label="judgmentText('workbench.saveReason')" :title="judgmentText('workbench.saveReason')" :disabled="feedbackSavingId === record.id" @click="saveReason(record)"><span aria-hidden="true">✓</span></button>
            </div>
          </details>
          <div class="judgment-feedback-actions">
            <button type="button" data-feedback="up" :aria-label="judgmentText('workbench.feedbackUp')" :aria-pressed="record.feedback.vote === 'up'" :title="judgmentText('workbench.feedbackUp')" :disabled="feedbackSavingId === record.id" @click="feedback(record, 'up')"><span aria-hidden="true">👍</span><span class="visually-hidden">{{ judgmentText('workbench.feedbackUp') }}</span></button>
            <button type="button" data-feedback="down" :aria-label="judgmentText('workbench.feedbackDown')" :aria-pressed="record.feedback.vote === 'down'" :title="judgmentText('workbench.feedbackDown')" :disabled="feedbackSavingId === record.id" @click="feedback(record, 'down')"><span aria-hidden="true">👎</span><span class="visually-hidden">{{ judgmentText('workbench.feedbackDown') }}</span></button>
            <GrowthLoading v-if="feedbackSavingId === record.id" data-feedback-saving variant="inline" :label="judgmentText('workbench.feedbackSaving')" />
          </div>
        </section>
      </article>
    </div>
  </section>
</template>

<style scoped>
.judgment-workbench { display: grid; gap: 18px; min-width: 0; min-height: 0; padding: 2px 24px 24px; overflow: auto; }
.judgment-workbench-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.judgment-workbench-heading h2 { margin: 0; color: var(--color-ink); font-size: 20px; }
.judgment-workbench-heading p { margin: 6px 0 0; color: var(--color-muted); font-size: 13px; }
.judgment-workbench-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.judgment-filter { display: inline-flex; width: fit-content; gap: 4px; padding: 3px; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-surface-subtle); }
.judgment-filter button { min-height: 32px; padding: 5px 12px; border: 0; border-radius: 999px; color: var(--color-muted); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.judgment-filter button[aria-pressed=true] { color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-subtle); }
.judgment-record-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 14px; }
.judgment-record-card { display: grid; align-content: start; gap: 13px; padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.judgment-record-card.is-human-needed { border-color: color-mix(in srgb, var(--color-warning) 48%, var(--color-border)); }
.judgment-record-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.judgment-record-heading h3 { margin: 4px 0 0; color: var(--color-ink); font-size: 16px; overflow-wrap: anywhere; }
.judgment-record-kind { color: var(--color-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.judgment-outcome { flex: 0 0 auto; padding: 4px 8px; border-radius: 999px; color: var(--color-muted); background: var(--color-surface-subtle); font-size: 11px; }
.judgment-outcome.is-escalate, .judgment-outcome.is-failed { color: var(--color-danger); background: var(--color-danger-soft); }
.judgment-outcome.is-approve { color: var(--color-success); background: var(--color-success-soft); }
.judgment-record-summary { margin: 0; color: var(--color-ink); font-size: 13px; line-height: 1.65; }
.judgment-record-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; }
.judgment-record-meta div { display: grid; gap: 3px; min-width: 0; }
.judgment-record-meta dt { color: var(--color-muted); font-size: 11px; }
.judgment-record-meta dd { margin: 0; color: var(--color-ink); font-size: 12px; overflow-wrap: anywhere; }
.judgment-record-evidence { display: grid; gap: 7px; }
.judgment-record-evidence h4 { margin: 0; color: var(--color-muted); font-size: 12px; }
.judgment-record-evidence ul { display: grid; gap: 5px; margin: 0; padding-left: 18px; color: var(--color-ink); font-size: 12px; line-height: 1.5; }
.judgment-record-details { display: grid; gap: 9px; color: var(--color-muted); font-size: 12px; }
.judgment-record-details summary,
.judgment-feedback-editor summary { width: fit-content; color: var(--color-muted); cursor: pointer; }
.judgment-record-details summary:hover,
.judgment-feedback-editor summary:hover { color: var(--color-ink); }
.judgment-record-detail-list { display: grid; gap: 8px; margin: 0; }
.judgment-record-detail-list div { display: grid; gap: 3px; }
.judgment-record-detail-list dt { color: var(--color-muted); font-size: 11px; }
.judgment-record-detail-list dd { margin: 0; color: var(--color-ink); overflow-wrap: anywhere; }
.judgment-record-detail-block { display: grid; gap: 5px; }
.judgment-record-detail-block h4 { margin: 0; color: var(--color-muted); font-size: 11px; }
.judgment-record-detail-block p { margin: 0; color: var(--color-ink); }
.judgment-record-detail-block pre { max-height: 160px; margin: 0; padding: 8px; overflow: auto; border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface-subtle); font: inherit; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
.judgment-record-feedback { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.judgment-feedback-editor { display: grid; gap: 8px; }
.judgment-feedback-editor-row { display: flex; align-items: flex-start; gap: 6px; }
.judgment-record-feedback textarea { width: 100%; resize: vertical; }
.judgment-feedback-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.judgment-feedback-actions button { min-height: 30px; padding: 5px 8px; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-muted); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.judgment-feedback-actions button[aria-pressed=true] { border-color: var(--color-accent); color: var(--color-accent); background: var(--color-accent-soft); }
.judgment-save-reason { display: grid; width: 30px; height: 30px; flex: 0 0 30px; place-items: center; padding: 0; border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-muted); background: transparent; cursor: pointer; }
.judgment-save-reason:disabled { cursor: wait; opacity: .6; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.judgment-workbench-error { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-danger-soft); font-size: 13px; }
.judgment-workbench-empty { padding: 40px 20px; color: var(--color-muted); text-align: center; }
@media (max-width: 760px) { .judgment-workbench { padding-inline: 16px; }.judgment-workbench-heading { display: grid; }.judgment-workbench-actions { justify-content: flex-start; } }
</style>
