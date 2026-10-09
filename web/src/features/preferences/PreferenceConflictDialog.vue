<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { patchJson, postJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSegmented from '@/components/ui/UiSegmented.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { formatTime, latestItemValue } from '@/features/knowledge/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem, PersonalProject } from '@/types'
import {
  mergePreferenceValues,
  preferenceValue,
  type PreferenceConflict,
  type PreferenceConflictAction,
} from './preference-conflicts'

const props = defineProps<{
  conflict: PreferenceConflict | null
  personalSpaceId: string
  projects: PersonalProject[]
}>()

const emit = defineEmits<{
  close: []
  resolved: []
  edit: [item: KnowledgeItem]
}>()

const store = useConsoleStore()
const action = ref<PreferenceConflictAction | null>(null)
const mergeTarget = ref<'left' | 'right'>('right')
const splitItem = ref<'left' | 'right'>('right')
const splitProjectId = ref('')
const mergedValue = ref('')
const reason = ref('')
const generatedReason = ref('')
const busy = ref(false)
const localError = ref('')

const splitProjects = computed(() => {
  const conflict = props.conflict
  if (!conflict) return []
  const item = splitItem.value === 'left' ? conflict.left : conflict.right
  return props.projects.filter(
    ({ project_id: projectId }) =>
      item.preferenceScope !== 'project' || projectId !== item.preferenceProjectId,
  )
})
const canSplit = computed(() => splitProjects.value.length > 0)
const splitProjectOptions = computed(() => splitProjects.value.map((project) => ({
  value: project.project_id,
  label: project.profile.name,
})))
const differenceColumns = computed(() => {
  const difference = props.conflict?.difference
  if (!difference) return []
  return [
    { key: 'shared', label: t('preferences.dialog.shared'), values: difference.shared, empty: t('preferences.dialog.noShared') },
    { key: 'left', label: t('preferences.dialog.onlyA'), values: difference.leftOnly, empty: t('preferences.dialog.noUnique') },
    { key: 'right', label: t('preferences.dialog.onlyB'), values: difference.rightOnly, empty: t('preferences.dialog.noUnique') },
  ]
})
const impactPreview = computed(() => {
  const conflict = props.conflict
  if (!conflict || !action.value) {
    return t('preferences.dialog.impact.choose')
  }
  if (action.value === 'merge') {
    const target = mergeTarget.value === 'left' ? conflict.left : conflict.right
    const historical = mergeTarget.value === 'left' ? conflict.right : conflict.left
    return t('preferences.dialog.impact.merge', {
      target: target.title,
      historical: historical.title,
    })
  }
  if (action.value === 'keep_left' || action.value === 'keep_right') {
    const kept = action.value === 'keep_left' ? conflict.left : conflict.right
    const historical = action.value === 'keep_left' ? conflict.right : conflict.left
    return t('preferences.dialog.impact.keep', {
      kept: kept.title,
      historical: historical.title,
    })
  }
  const item = splitItem.value === 'left' ? conflict.left : conflict.right
  const project = splitProjects.value.find(
    ({ project_id: projectId }) => projectId === splitProjectId.value,
  )
  return project
    ? t('preferences.dialog.impact.split', {
        item: item.title,
        project: project.profile.name,
      })
    : t('preferences.dialog.impact.chooseProject')
})

watch(
  () => props.conflict,
  (conflict) => {
    if (!conflict) return
    mergeTarget.value = 'right'
    splitItem.value = 'right'
    mergedValue.value = mergePreferenceValues(
      preferenceValue(conflict.right),
      preferenceValue(conflict.left),
    )
    action.value = conflict.recommendedAction
    splitProjectId.value = ''
    localError.value = ''
    setGeneratedReason(conflict.recommendedAction)
  },
  { immediate: true },
)

watch([splitItem, splitProjects], () => {
  if (
    splitProjectId.value
    && splitProjects.value.some(
      ({ project_id: projectId }) => projectId === splitProjectId.value,
    )
  ) return
  splitProjectId.value = splitProjects.value[0]?.project_id ?? ''
}, { immediate: true })

function chooseAction(nextAction: PreferenceConflictAction) {
  if (busy.value) return
  action.value = nextAction
  if (!reason.value.trim() || reason.value === generatedReason.value) {
    setGeneratedReason(nextAction)
  }
}

function setGeneratedReason(nextAction: PreferenceConflictAction | null) {
  const conflict = props.conflict
  const nextReason = conflict && nextAction
    ? defaultReason(nextAction, conflict)
    : ''
  generatedReason.value = nextReason
  reason.value = nextReason
}

async function resolveConflict() {
  if (busy.value) return
  const conflict = props.conflict
  if (!conflict || !action.value) {
    return fail(t('preferences.dialog.errors.actionRequired'))
  }
  if (!reason.value.trim()) {
    return fail(t('preferences.dialog.errors.reasonRequired'))
  }
  if (action.value === 'merge' && !mergedValue.value.trim()) {
    return fail(t('preferences.dialog.errors.mergedValueRequired'))
  }
  if (action.value === 'split_scope' && !splitProjectId.value) {
    return fail(t('preferences.dialog.errors.projectRequired'))
  }

  const submittedAction = action.value
  const submittedReason = reason.value.trim()
  const submittedSpace = props.personalSpaceId
  busy.value = true
  localError.value = ''
  try {
    if (submittedAction === 'merge') await mergeConflict(conflict)
    else if (submittedAction === 'split_scope') await splitConflictScope(conflict)
    else await keepOneConflictItem(conflict, submittedAction)
    if (conflict.aiRecord) {
      await postJson(
        `/api/preference-conflicts/${encodeURIComponent(conflict.aiRecord.id)}/complete`,
        {
          personalSpaceId: submittedSpace,
          resolution: submittedAction,
          reason: submittedReason,
        },
      )
    }
    store.notify(t('preferences.dialog.resolved'))
    emit('resolved')
    emit('close')
  } catch (error) {
    localError.value = error instanceof Error
      ? error.message
      : t('preferences.dialog.errors.failed')
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

async function mergeConflict(conflict: PreferenceConflict) {
  const submittedReason = reason.value.trim()
  const submittedSpace = props.personalSpaceId
  const target = mergeTarget.value === 'left' ? conflict.left : conflict.right
  const historical = mergeTarget.value === 'left' ? conflict.right : conflict.left
  const update: Record<string, unknown> = {
    personalSpaceId: submittedSpace,
    personalProjectId: null,
    action: 'update',
    reason: submittedReason,
  }
  if (target.itemKind === 'entity') {
    update.name = target.title
    update.summary = mergedValue.value.trim()
  } else {
    update.fact = mergedValue.value.trim()
  }
  if (target.classificationExplicit && target.originQuadrant !== 'unclassified') {
    update.originQuadrant = target.originQuadrant
    update.confirmationStatus = 'confirmed'
    update.confirmationBasis = {
      existenceReason: t('preferences.dialog.audit.mergedFromConflict', {
        reason: conflict.reason,
      }),
      quadrantReason: target.confirmationBasis?.quadrant_reason
        || target.reasoningSummary
        || t('preferences.dialog.audit.keepQuadrant'),
      proposedBy: target.confirmationBasis?.proposed_by
        ? actorInput(target.confirmationBasis.proposed_by)
        : { kind: 'import', label: t('preferences.dialog.audit.historicalRecord') },
      confirmedBy: { kind: 'user', label: t('preferences.dialog.audit.user') },
      confirmedAt: new Date().toISOString(),
    }
  }

  await patchJson(
    `/api/knowledge/${target.itemKind}/${encodeURIComponent(target.id)}`,
    update,
  )
  await patchJson(
    `/api/knowledge/${historical.itemKind}/${encodeURIComponent(historical.id)}`,
    {
      personalSpaceId: submittedSpace,
      personalProjectId: null,
      action: 'invalidate',
      reason: submittedReason,
      replacementItemId: target.id,
      replacementItemKind: target.itemKind,
    },
  )
}

async function keepOneConflictItem(
  conflict: PreferenceConflict,
  selectedAction: 'keep_left' | 'keep_right',
) {
  const kept = selectedAction === 'keep_left' ? conflict.left : conflict.right
  const historical = selectedAction === 'keep_left' ? conflict.right : conflict.left
  await patchJson(
    `/api/knowledge/${historical.itemKind}/${encodeURIComponent(historical.id)}`,
    {
      personalSpaceId: props.personalSpaceId,
      personalProjectId: null,
      action: 'invalidate',
      reason: reason.value.trim(),
      replacementItemId: kept.id,
      replacementItemKind: kept.itemKind,
    },
  )
}

async function splitConflictScope(conflict: PreferenceConflict) {
  const item = splitItem.value === 'left' ? conflict.left : conflict.right
  await postJson(
    `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}/preference-scope`,
    {
      personalSpaceId: props.personalSpaceId,
      scope: 'project',
      projectId: splitProjectId.value,
      reason: reason.value.trim(),
    },
  )
}

function actorInput(actor: { kind: string; label?: string | null }) {
  return { kind: actor.kind, label: actor.label ?? null }
}

function defaultReason(
  nextAction: PreferenceConflictAction,
  conflict: PreferenceConflict,
) {
  if (nextAction === 'merge') {
    return t('preferences.dialog.defaultReason.merge')
  }
  if (nextAction === 'keep_left') {
    return t('preferences.dialog.defaultReason.keepLeft', {
      title: conflict.left.title,
    })
  }
  if (nextAction === 'keep_right') {
    return t('preferences.dialog.defaultReason.keepRight', {
      title: conflict.right.title,
    })
  }
  return t('preferences.dialog.defaultReason.split')
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <UiDialog v-if="conflict" open class="conflict-resolution-dialog" size="xl" :busy="busy" :error="localError"
    :title="t('preferences.dialog.title')" :description="t('preferences.dialog.intro', { reason: conflict.reason })"
    @close="emit('close')">
    <section class="conflict-pair-context" :aria-label="t('preferences.dialog.basisAria')">
      <span>{{ t('preferences.dialog.preferenceKey') }}<strong>{{ conflict.preferenceKey }}</strong></span>
      <span>{{ t('preferences.dialog.effectiveScope') }}<strong>{{ conflict.scopeLabel }}</strong></span>
      <span>{{ t('preferences.dialog.suggestion') }}<strong>{{ conflict.recommendedAction === 'merge' ? t('preferences.dialog.mergeSuggestion') : t('preferences.dialog.reviewSuggestion') }}</strong></span>
    </section>

    <section class="conflict-comparison" :aria-label="t('preferences.dialog.comparisonAria')">
      <article v-for="side in (['left', 'right'] as const)" :key="side" class="conflict-side" :class="`conflict-side-${side}`">
        <div class="conflict-side-heading">
          <span>{{ t(side === 'left' ? 'preferences.dialog.older' : 'preferences.dialog.newer') }}</span>
          <time>{{ formatTime(latestItemValue(conflict[side])) }}</time>
        </div>
        <h3>{{ conflict[side].title }}</h3>
        <p>{{ preferenceValue(conflict[side]) }}</p>
        <small>{{ t('preferences.dialog.sourceCount', { count: conflict[side].evidence.length }) }} · {{ conflict[side].id }}</small>
        <UiButton size="sm" variant="ghost" @click="emit('edit', conflict[side])">{{ t(side === 'left' ? 'preferences.dialog.editA' : 'preferences.dialog.editB') }}</UiButton>
      </article>
    </section>

    <section class="conflict-difference" :aria-label="t('preferences.dialog.differenceAria')">
      <div v-for="column in differenceColumns" :key="column.key">
        <span>{{ column.label }}</span>
        <p v-if="column.values.length"><b v-for="value in column.values" :key="value">{{ value }}</b></p>
        <p v-else class="ui-muted">{{ column.empty }}</p>
      </div>
    </section>

    <fieldset class="conflict-inputs" :disabled="busy">
      <section class="conflict-resolution-options" :aria-label="t('preferences.dialog.actionsAria')">
        <button type="button" :aria-pressed="action === 'merge'" @click="chooseAction('merge')">
          <strong>{{ t('preferences.dialog.actions.merge') }}</strong>
          <span>{{ t('preferences.dialog.actions.mergeCopy') }}</span>
          <em v-if="conflict.recommendedAction === 'merge'">{{ t('preferences.dialog.actions.recommended') }}</em>
        </button>
        <button type="button" :aria-pressed="action === 'keep_left'" @click="chooseAction('keep_left')">
          <strong>{{ t('preferences.dialog.actions.keepA') }}</strong>
          <span>{{ t('preferences.dialog.actions.keepACopy') }}</span>
        </button>
        <button type="button" :aria-pressed="action === 'keep_right'" @click="chooseAction('keep_right')">
          <strong>{{ t('preferences.dialog.actions.keepB') }}</strong>
          <span>{{ t('preferences.dialog.actions.keepBCopy') }}</span>
        </button>
        <button type="button" :disabled="!canSplit" :aria-pressed="action === 'split_scope'" @click="chooseAction('split_scope')">
          <strong>{{ t('preferences.dialog.actions.split') }}</strong>
          <span>{{ canSplit ? t('preferences.dialog.actions.splitCopy') : t('preferences.dialog.actions.noProjects') }}</span>
        </button>
      </section>

      <section v-if="action === 'merge'" class="conflict-resolution-detail">
        <div class="conflict-inline-options">
          <span>{{ t('preferences.dialog.canonicalIdentity') }}</span>
          <UiSegmented v-model="mergeTarget" :label="t('preferences.dialog.mergeIdentityAria')"
            :options="[{ value: 'left', label: t('preferences.dialog.identityA') }, { value: 'right', label: t('preferences.dialog.identityB') }]" />
        </div>
        <label class="ui-field">{{ t('preferences.dialog.mergedContent') }}<textarea v-model="mergedValue" rows="4" maxlength="4096" /></label>
      </section>

      <section v-if="action === 'split_scope'" class="conflict-resolution-detail">
        <div class="conflict-inline-options">
          <span>{{ t('preferences.dialog.adjustRecord') }}</span>
          <UiSegmented v-model="splitItem" :label="t('preferences.dialog.splitRecordAria')"
            :options="[{ value: 'left', label: 'A' }, { value: 'right', label: 'B' }]" />
        </div>
        <UiSelect v-model="splitProjectId" field :label="t('preferences.dialog.projectOnly')" :placeholder="t('preferences.dialog.chooseProject')" :options="splitProjectOptions" />
      </section>

      <section class="conflict-impact-preview">
        <span>{{ t('preferences.dialog.impactTitle') }}</span>
        <p>{{ impactPreview }}</p>
      </section>

      <label class="ui-field conflict-resolution-reason">{{ t('preferences.dialog.reason') }}<textarea v-model="reason" rows="2" maxlength="2000" /></label>
    </fieldset>

    <template #footer>
      <span class="conflict-footer-note">{{ t('preferences.dialog.pendingCopy') }}</span>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('preferences.dialog.defer') }}</UiButton>
      <UiButton variant="primary" :disabled="!action" :busy="busy" :busy-label="t('preferences.dialog.processing')" @click="resolveConflict">{{ t('preferences.dialog.confirm') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.conflict-inputs { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 0; border: 0; }
.conflict-pair-context { display: flex; flex-wrap: wrap; gap: 8px; }
.conflict-pair-context span { padding: 4px 10px; border-radius: 999px; color: var(--color-muted); background: var(--color-surface-subtle); font-size: 12px; }
.conflict-pair-context strong { margin-left: 6px; color: var(--color-ink); font-weight: 600; }
.conflict-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.conflict-side { display: grid; align-content: start; gap: 8px; min-width: 0; padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.conflict-side-left { background: var(--color-surface-subtle); }
.conflict-side-heading { display: flex; justify-content: space-between; gap: 12px; color: var(--color-muted); font-size: 12px; }
.conflict-side h3, .conflict-side p { margin: 0; }
.conflict-side h3 { font-size: 14px; font-weight: 600; }
.conflict-side p { min-height: 48px; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
.conflict-side small { overflow: hidden; color: var(--color-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.conflict-side .ui-button { justify-self: start; }
.conflict-difference { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.conflict-difference > div { display: grid; align-content: start; gap: 6px; min-width: 0; }
.conflict-difference span { color: var(--color-muted); font-size: 12px; font-weight: 600; }
.conflict-difference p { display: flex; flex-wrap: wrap; gap: 5px; margin: 0; font-size: 12px; }
.conflict-difference b { padding: 2px 7px; border-radius: 5px; background: var(--color-surface-subtle); font-weight: 500; }
.conflict-resolution-options { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.conflict-resolution-options > button {
  position: relative; display: grid; align-content: start; gap: 4px; min-height: 80px; padding: 12px;
  border: 1px solid var(--color-border); border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface);
  text-align: left; cursor: pointer; transition: border-color var(--motion-fast), background-color var(--motion-fast);
}
.conflict-resolution-options > button:hover:not(:disabled) { border-color: var(--color-border-strong); }
.conflict-resolution-options > button[aria-pressed='true'] { border-color: var(--color-accent); background: var(--color-accent-soft); }
.conflict-resolution-options > button:disabled { opacity: .5; cursor: not-allowed; }
.conflict-resolution-options strong { font-size: 13px; }
.conflict-resolution-options span { color: var(--color-muted); font-size: 12px; line-height: 1.45; }
.conflict-resolution-options em { position: absolute; top: 8px; right: 8px; padding: 1px 6px; border-radius: 999px; color: var(--color-accent); background: var(--color-surface); font-size: 11px; font-style: normal; }
.conflict-resolution-detail, .conflict-impact-preview { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.conflict-inline-options { display: flex; align-items: center; gap: 10px; color: var(--color-muted); font-size: 12px; }
.conflict-impact-preview span { color: var(--color-warning); font-size: 12px; font-weight: 600; }
.conflict-impact-preview p { margin: 0; font-size: 13px; line-height: 1.55; }
.conflict-footer-note { margin-right: auto; color: var(--color-muted); font-size: 12px; }
@media (max-width: 900px) {
  .conflict-comparison, .conflict-difference { grid-template-columns: 1fr; }
  .conflict-resolution-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
