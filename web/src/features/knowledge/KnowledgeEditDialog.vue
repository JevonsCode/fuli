<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import { patchJson, postJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { t } from '@/i18n'
import { quadrantLabel } from './model'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeEdge, KnowledgeItem, KnowledgeNode, PersonalProject } from '@/types'

type PendingAction =
  | 'correction'
  | 'invalidate'
  | 'restore'
  | 'replacement'
  | 'ownership'
  | 'scope'

const props = withDefaults(defineProps<{
  item: KnowledgeItem | null
  personalSpaceId: string
  personalProjectId: string | null
  projects: PersonalProject[]
  replacementItems?: KnowledgeItem[]
}>(), {
  replacementItems: () => [],
})

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useConsoleStore()
const busy = ref(false)
const pendingAction = ref<PendingAction | null>(null)
const localError = ref('')
const assignmentReason = ref('')
const targetProjectId = ref('')
const preferenceScope = ref('global')
const preferenceProjectId = ref('')
const preferenceReason = ref('')
const inheritanceProjectId = ref('')
const replacementItemKey = ref('')
const form = reactive({
  name: '',
  summary: '',
  fact: '',
  currentQuadrant: '',
  confirmationStatus: 'pending',
  existenceReason: '',
  quadrantReason: '',
  proposedByKind: 'agent',
  proposedByLabel: '',
  confirmedByKind: 'user',
  confirmedByLabel: '',
  profileAspect: 'none',
  inheritanceMode: 'local_only',
  reason: '',
})

const relationship = computed(() => props.item?.itemKind === 'relationship')
const invalid = computed(() => Boolean(props.item?.invalidAt))
const profilePreference = computed(() => Boolean(props.item?.raw.profile_aspect))
const projectOptions = computed(() =>
  props.projects.map((project) => ({
    value: project.project_id,
    label: project.profile.name,
    meta: `#${compactIdentity(project.project_id, 26)}`,
    search: identitySearchText(project.project_id),
  })),
)
const quadrantOptions = computed(() =>
  ['known_known', 'known_unknown', 'unknown_known', 'unknown_unknown']
    .map((value) => ({
      value,
      label: t(`knowledge.dialogs.edit.quadrants.${value}`),
    })),
)
const confirmationStatusOptions = computed(() => [
  {
    value: 'pending',
    label: t('knowledge.dialogs.edit.confirmationStates.pending'),
  },
  {
    value: 'confirmed',
    label: t('knowledge.dialogs.edit.confirmationStates.confirmed'),
  },
])
const inheritanceModeOptions = computed(() => [
  { value: 'local_only', label: t('knowledge.dialogs.edit.inheritance.local') },
  {
    value: 'descendants',
    label: t('knowledge.dialogs.edit.inheritance.descendants'),
  },
  {
    value: 'selected_projects',
    label: t('knowledge.dialogs.edit.inheritance.selected'),
  },
])
const proposerOptions = computed(() =>
  ['user', 'agent', 'authoritative_source', 'import'].map((value) => ({
    value,
    label: t(`knowledge.domain.actors.${value}`),
  })),
)
const confirmerOptions = computed(() =>
  ['user', 'authoritative_source'].map((value) => ({
    value,
    label: t(`knowledge.domain.actors.${value}`),
  })),
)
const profileAspectOptions = computed(() => [
  { value: 'none', label: t('knowledge.dialogs.edit.profiles.none') },
  ...['taste', 'personality', 'judgment_preference'].map((value) => ({
    value,
    label: t(`knowledge.domain.profiles.${value}`),
  })),
])
const preferenceScopeOptions = computed(() => [
  { value: 'global', label: t('knowledge.dialogs.edit.scopes.global') },
  {
    value: 'project',
    label: t('knowledge.dialogs.edit.scopes.project'),
    disabled: props.projects.length === 0,
  },
])
const replacementOptions = computed(() => [
  { value: '', label: t('knowledge.dialogs.edit.replacementNone') },
  ...props.replacementItems
    .filter((candidate) =>
      !candidate.invalidAt
      && (
        candidate.itemKind !== props.item?.itemKind
        || candidate.id !== props.item?.id
      ),
    )
    .map((candidate) => ({
      value: replacementKey(candidate.itemKind, candidate.id),
      label: candidate.title,
      meta: candidate.type,
      search: `${candidate.body} ${candidate.id}`,
    })),
])
const selectedReplacement = computed(() => {
  if (!replacementItemKey.value) return null
  try {
    const [itemKind, id] = JSON.parse(replacementItemKey.value)
    if (
      (itemKind !== 'entity' && itemKind !== 'relationship')
      || typeof id !== 'string'
    ) return null
    return { itemKind, id } as const
  } catch {
    return null
  }
})
const currentProjectId = computed(() => {
  const assignment = props.item?.assignments.at(0) as { project_id?: string } | undefined
  return assignment?.project_id
    ?? props.item?.evidence.find(({ personal_project_id }) => personal_project_id)
      ?.personal_project_id
    ?? props.personalProjectId
    ?? null
})

watch(
  () => props.item,
  (item) => {
    if (!item) return
    const raw = item.raw
    form.name = item.itemKind === 'entity' ? (raw as KnowledgeNode).name : ''
    form.summary = item.itemKind === 'entity' ? ((raw as KnowledgeNode).summary ?? '') : ''
    form.fact = item.itemKind === 'relationship' ? ((raw as KnowledgeEdge).fact ?? '') : ''
    const basis = item.confirmationBasis
    const evidence = item.evidence.at(0)
    form.currentQuadrant = item.classificationExplicit
      ? raw.current_quadrant ?? raw.origin_quadrant ?? 'known_known'
      : ''
    form.confirmationStatus = item.confirmationStatus === 'confirmed' ? 'confirmed' : 'pending'
    form.existenceReason = basis?.existence_reason
      ?? evidence?.source_description
      ?? evidence?.summary
      ?? ''
    form.quadrantReason = basis?.quadrant_reason ?? raw.reasoning_summary ?? ''
    form.proposedByKind = basis?.proposed_by.kind ?? 'agent'
    form.proposedByLabel = basis?.proposed_by.label ?? ''
    form.confirmedByKind = basis?.confirmed_by?.kind ?? 'user'
    form.confirmedByLabel = basis?.confirmed_by?.label ?? ''
    form.profileAspect = raw.profile_aspect ?? 'none'
    form.inheritanceMode = raw.profile_aspect
      ? 'local_only'
      : raw.inheritance_mode ?? 'local_only'
    inheritanceProjectId.value = raw.inherited_project_ids?.at(0)
      ?? props.projects[0]?.project_id
      ?? ''
    form.reason = ''
    assignmentReason.value = ''
    targetProjectId.value = currentProjectId.value ?? props.projects[0]?.project_id ?? ''
    preferenceScope.value = raw.preference_scope ?? 'global'
    preferenceProjectId.value = raw.preference_project_id ?? props.projects[0]?.project_id ?? ''
    preferenceReason.value = ''
    replacementItemKey.value = item.replacedByItemId && item.replacedByItemKind
      ? replacementKey(item.replacedByItemKind, item.replacedByItemId)
      : ''
    localError.value = ''
  },
  { immediate: true },
)

async function saveCorrection() {
  const item = props.item
  if (!item) return
  if (!form.reason.trim()) return fail(t('knowledge.dialogs.edit.errors.reasonRequired'))
  if (!relationship.value && !form.name.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.nameRequired'))
  }
  if (relationship.value && !form.fact.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.factRequired'))
  }
  if (!form.currentQuadrant || !form.confirmationStatus) {
    return fail(t('knowledge.dialogs.edit.errors.classificationRequired'))
  }
  if (!form.existenceReason.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.existenceRequired'))
  }
  if (!form.quadrantReason.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.quadrantRequired'))
  }
  if (!form.proposedByKind) return fail(t('knowledge.dialogs.edit.errors.proposerRequired'))
  if (form.confirmationStatus === 'confirmed' && !form.confirmedByKind) {
    return fail(t('knowledge.dialogs.edit.errors.confirmerRequired'))
  }
  if (
    form.inheritanceMode === 'selected_projects'
    && !inheritanceProjectId.value
  ) return fail(t('knowledge.dialogs.edit.errors.inheritedProjectsRequired'))

  const body: Record<string, unknown> = {
    ...baseRevision('update'),
    confirmationStatus: form.confirmationStatus,
    confirmationBasis: {
      existenceReason: form.existenceReason.trim(),
      quadrantReason: form.quadrantReason.trim(),
      proposedBy: {
        kind: form.proposedByKind,
        label: form.proposedByLabel.trim() || null,
      },
      confirmedBy: form.confirmationStatus === 'confirmed'
        ? {
            kind: form.confirmedByKind,
            label: form.confirmedByLabel.trim() || null,
          }
        : null,
      confirmedAt: form.confirmationStatus === 'confirmed'
        ? new Date().toISOString()
        : null,
    },
    profileAspect: form.profileAspect,
    inheritanceMode: form.profileAspect === 'none'
      ? form.inheritanceMode
      : 'local_only',
    inheritedProjectIds: (
      form.profileAspect === 'none'
      && form.inheritanceMode === 'selected_projects'
    ) ? [inheritanceProjectId.value] : [],
    reasoningSummary: form.quadrantReason.trim(),
  }
  if (props.item.classificationExplicit) {
    body.currentQuadrant = form.currentQuadrant
  } else {
    body.originQuadrant = form.currentQuadrant
  }
  if (relationship.value) body.fact = form.fact.trim()
  else {
    body.name = form.name.trim()
    body.summary = form.summary.trim()
  }
  await execute('correction', async () => {
    await patchJson(`/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`, body)
    store.notify(t('knowledge.dialogs.edit.notices.corrected'))
  })
}

async function changeStatus(action: 'invalidate' | 'restore') {
  const item = props.item
  if (!item) return
  if (!form.reason.trim()) {
    return fail(
      action === 'invalidate'
        ? t('knowledge.dialogs.edit.errors.statusReasonRequired')
        : t('knowledge.dialogs.edit.errors.restoreReasonRequired'),
    )
  }
  await execute(action === 'invalidate' ? 'invalidate' : 'restore', async () => {
    const body: Record<string, unknown> = baseRevision(action)
    if (action === 'invalidate' && selectedReplacement.value) {
      body.replacementItemId = selectedReplacement.value.id
      body.replacementItemKind = selectedReplacement.value.itemKind
    }
    await patchJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`,
      body,
    )
    store.notify(
      action === 'invalidate'
        ? selectedReplacement.value
          ? t('knowledge.dialogs.edit.notices.invalidatedWithReplacement')
          : t('knowledge.dialogs.edit.notices.invalidated')
        : t('knowledge.dialogs.edit.notices.restored'),
    )
  })
}

async function saveReplacement() {
  const item = props.item
  const replacement = selectedReplacement.value
  if (!item || !invalid.value) return
  if (!replacement) return fail(t('knowledge.dialogs.edit.errors.replacementRequired'))
  if (!form.reason.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.replacementReasonRequired'))
  }
  await execute('replacement', async () => {
    await patchJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`,
      {
        ...baseRevision('link_replacement'),
        replacementItemId: replacement.id,
        replacementItemKind: replacement.itemKind,
      },
    )
    store.notify(t('knowledge.dialogs.edit.notices.replacementSaved'))
  })
}

async function saveAssignment() {
  const item = props.item
  if (!item) return
  if (!targetProjectId.value) return fail(t('knowledge.dialogs.edit.errors.projectRequired'))
  if (!assignmentReason.value.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.assignmentReasonRequired'))
  }
  if (targetProjectId.value === currentProjectId.value) {
    return fail(t('knowledge.dialogs.edit.errors.alreadyAssigned'))
  }
  await execute('ownership', async () => {
    await postJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}/assignment`,
      {
        personalSpaceId: props.personalSpaceId,
        targetProjectId: targetProjectId.value,
        reason: assignmentReason.value.trim(),
      },
    )
    store.notify(t('knowledge.dialogs.edit.notices.assignmentChanged'))
  })
}

async function savePreferenceScope() {
  const item = props.item
  if (!item) return
  const projectId = preferenceScope.value === 'project' ? preferenceProjectId.value : null
  if (preferenceScope.value === 'project' && !projectId) {
    return fail(t('knowledge.dialogs.edit.errors.preferenceProjectRequired'))
  }
  if (!preferenceReason.value.trim()) {
    return fail(t('knowledge.dialogs.edit.errors.preferenceReasonRequired'))
  }
  await execute('scope', async () => {
    await postJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}/preference-scope`,
      {
        personalSpaceId: props.personalSpaceId,
        scope: preferenceScope.value,
        projectId,
        reason: preferenceReason.value.trim(),
      },
    )
    store.notify(
      preferenceScope.value === 'global'
        ? t('knowledge.dialogs.edit.notices.preferenceGlobal')
        : t('knowledge.dialogs.edit.notices.preferenceProject'),
    )
  })
}

function baseRevision(action: string) {
  return {
    personalSpaceId: props.personalSpaceId,
    personalProjectId: props.personalProjectId,
    action,
    reason: form.reason.trim(),
  }
}

function replacementKey(itemKind: KnowledgeItem['itemKind'], itemId: string) {
  return JSON.stringify([itemKind, itemId])
}

async function execute(action: PendingAction, operation: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  pendingAction.value = action
  localError.value = ''
  try {
    await operation()
    emit('close')
    emit('saved')
  } catch (error) {
    localError.value = error instanceof Error
      ? error.message
      : t('knowledge.dialogs.edit.errors.saveFailed')
    store.reportError(error)
  } finally {
    busy.value = false
    pendingAction.value = null
  }
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <UiDialog v-if="item" open class="knowledge-edit-dialog" size="xl" :busy="busy" :error="localError"
    :title="invalid ? t('knowledge.dialogs.edit.titleRestore') : t('knowledge.dialogs.edit.titleCorrect')"
    :description="t('knowledge.dialogs.edit.intro')" @close="emit('close')">
    <div class="knowledge-edit-columns">
      <section>
        <h3>{{ t('knowledge.dialogs.edit.currentContent') }}</h3>
        <form class="knowledge-editor-form" @submit.prevent="saveCorrection">
          <fieldset class="knowledge-editor-group" :disabled="busy">
            <label v-if="!relationship" class="ui-field">{{ t('knowledge.dialogs.edit.name') }}<input v-model="form.name" maxlength="512" /></label>
            <label v-if="!relationship" class="ui-field">{{ t('knowledge.dialogs.edit.description') }}<textarea v-model="form.summary" maxlength="4096" rows="5" /></label>
            <label v-else class="ui-field">{{ t('knowledge.dialogs.edit.fact') }}<textarea v-model="form.fact" maxlength="8192" rows="5" /></label>
            <div class="knowledge-field-row">
              <UiSelect v-model="form.currentQuadrant" field :options="quadrantOptions" :label="t('knowledge.dialogs.edit.classification')" />
              <UiSelect v-model="form.confirmationStatus" field :options="confirmationStatusOptions" :label="t('knowledge.dialogs.edit.confirmationStatus')" />
              <UiSelect v-model="form.profileAspect" field :options="profileAspectOptions" :label="t('knowledge.dialogs.edit.preferenceDimension')" />
            </div>
            <p class="ui-meta">{{ t('knowledge.dialogs.edit.originQuadrant', { quadrant: quadrantLabel(item.originQuadrant) }) }}</p>
            <p v-if="!item.classificationExplicit" class="knowledge-warning">{{ t('knowledge.dialogs.edit.missingQuadrant') }}</p>
            <fieldset class="knowledge-editor-section">
              <legend>{{ t('knowledge.dialogs.edit.basis') }}</legend>
              <label class="ui-field">{{ t('knowledge.dialogs.edit.whyExists') }}<textarea v-model="form.existenceReason" maxlength="4096" rows="3" required /></label>
              <label class="ui-field">{{ t('knowledge.dialogs.edit.whyQuadrant') }}<textarea v-model="form.quadrantReason" maxlength="4096" rows="3" required /></label>
              <div class="knowledge-field-row knowledge-field-row--pair">
                <UiSelect v-model="form.proposedByKind" field :options="proposerOptions" :label="t('knowledge.dialogs.edit.proposer')" />
                <label class="ui-field">{{ t('knowledge.dialogs.edit.proposerDescription') }}<input v-model="form.proposedByLabel" maxlength="160" :placeholder="t('knowledge.dialogs.edit.proposerPlaceholder')" /></label>
                <template v-if="form.confirmationStatus === 'confirmed'">
                  <UiSelect v-model="form.confirmedByKind" field :options="confirmerOptions" :label="t('knowledge.dialogs.edit.confirmer')" />
                  <label class="ui-field">{{ t('knowledge.dialogs.edit.confirmerDescription') }}<input v-model="form.confirmedByLabel" maxlength="160" :placeholder="t('knowledge.dialogs.edit.confirmerPlaceholder')" /></label>
                </template>
              </div>
              <p class="ui-meta">{{ t('knowledge.dialogs.edit.agentConfirmedBoundary') }}</p>
            </fieldset>
            <fieldset v-if="!profilePreference" class="knowledge-editor-section">
              <legend>{{ t('knowledge.dialogs.edit.crossProjectInheritance') }}</legend>
              <UiSelect v-model="form.inheritanceMode" field :options="inheritanceModeOptions" :label="t('knowledge.dialogs.edit.inheritanceScope')" />
              <UiSelect v-if="form.inheritanceMode === 'selected_projects'" v-model="inheritanceProjectId" field :options="projectOptions" :label="t('knowledge.dialogs.edit.inheritedProjects')" searchable />
              <p class="ui-meta">{{ t('knowledge.dialogs.edit.inheritanceBoundary') }}</p>
            </fieldset>
            <fieldset class="knowledge-editor-section">
              <legend>{{ invalid ? t('knowledge.dialogs.edit.replacement') : t('knowledge.dialogs.edit.optionalReplacement') }}</legend>
              <UiSelect v-model="replacementItemKey" field :options="replacementOptions" searchable
                :label="invalid ? t('knowledge.dialogs.edit.historicalReplacement') : t('knowledge.dialogs.edit.activeReplacement')" />
              <p class="ui-meta">{{ t('knowledge.dialogs.edit.replacementBoundary') }}</p>
            </fieldset>
            <label class="ui-field">{{ t('knowledge.dialogs.edit.correctionReason') }}<textarea v-model="form.reason" maxlength="2000" rows="3" required /></label>
            <div class="knowledge-editor-actions">
              <UiButton v-if="!invalid" variant="danger" :busy="pendingAction === 'invalidate'" :busy-label="t('knowledge.dialogs.edit.invalidating')" @click="changeStatus('invalidate')">{{ t('knowledge.dialogs.edit.invalidate') }}</UiButton>
              <template v-else>
                <UiButton :busy="pendingAction === 'restore'" :busy-label="t('knowledge.dialogs.edit.restoring')" @click="changeStatus('restore')">{{ t('knowledge.dialogs.edit.restore') }}</UiButton>
                <UiButton :busy="pendingAction === 'replacement'" :busy-label="t('knowledge.dialogs.edit.savingReplacement')" @click="saveReplacement">{{ t('knowledge.dialogs.edit.saveReplacement') }}</UiButton>
              </template>
              <UiButton variant="primary" type="submit" :busy="pendingAction === 'correction'"
                :busy-label="t(form.confirmationStatus === 'confirmed' ? 'knowledge.dialogs.edit.savingConfirmed' : 'knowledge.dialogs.edit.savingPending')">
                {{ form.confirmationStatus === 'confirmed' ? t('knowledge.dialogs.edit.saveConfirmed') : t('knowledge.dialogs.edit.savePending') }}
              </UiButton>
            </div>
          </fieldset>
        </form>
      </section>

      <section v-if="!profilePreference">
        <h3>{{ t('knowledge.dialogs.edit.projectOwnership') }}</h3>
        <p class="ui-meta">{{ t('knowledge.dialogs.edit.ownershipCopy') }}</p>
        <form class="knowledge-editor-form" @submit.prevent="saveAssignment">
          <fieldset class="knowledge-editor-group" :disabled="busy">
            <UiSelect v-model="targetProjectId" field :options="projectOptions" :label="t('knowledge.dialogs.edit.targetProject')" searchable required />
            <label class="ui-field">{{ t('knowledge.dialogs.edit.assignmentReason') }}<textarea v-model="assignmentReason" maxlength="2000" rows="3" required /></label>
            <div class="knowledge-editor-actions">
              <UiButton variant="primary" type="submit" :disabled="projects.length === 0" :busy="pendingAction === 'ownership'" :busy-label="t('knowledge.dialogs.edit.changingOwnership')">{{ t('knowledge.dialogs.edit.adjustOwnership') }}</UiButton>
            </div>
          </fieldset>
        </form>
      </section>

      <section v-else>
        <h3>{{ t('knowledge.dialogs.edit.preferenceScope') }}</h3>
        <p class="ui-meta">{{ t('knowledge.dialogs.edit.preferenceScopeCopy') }}</p>
        <form class="knowledge-editor-form" @submit.prevent="savePreferenceScope">
          <fieldset class="knowledge-editor-group" :disabled="busy">
            <UiSelect v-model="preferenceScope" field :options="preferenceScopeOptions" :label="t('knowledge.dialogs.edit.effectiveScope')" />
            <UiSelect v-if="preferenceScope === 'project'" v-model="preferenceProjectId" field :options="projectOptions" :label="t('knowledge.dialogs.edit.personalProject')" searchable />
            <label class="ui-field">{{ t('knowledge.dialogs.edit.assignmentReason') }}<textarea v-model="preferenceReason" maxlength="2000" rows="3" required /></label>
            <div class="knowledge-editor-actions">
              <UiButton variant="primary" type="submit" :busy="pendingAction === 'scope'" :busy-label="t('knowledge.dialogs.edit.savingScope')">{{ t('knowledge.dialogs.edit.saveScope') }}</UiButton>
            </div>
          </fieldset>
        </form>
      </section>
    </div>
  </UiDialog>
</template>

<style scoped>
.knowledge-edit-columns { display: grid; grid-template-columns: 1.15fr .85fr; gap: 28px; }
.knowledge-edit-columns > section { display: grid; align-content: start; gap: 6px; min-width: 0; }
.knowledge-edit-columns > section + section { padding-left: 28px; border-left: 1px solid var(--color-border); }
.knowledge-edit-columns h3 { margin: 0; font-size: 13px; font-weight: 600; }
.knowledge-edit-columns p { margin: 0; }
.knowledge-editor-form { margin-top: 10px; }
.knowledge-editor-group { display: grid; gap: 14px; min-width: 0; margin: 0; padding: 0; border: 0; }
.knowledge-field-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.knowledge-field-row--pair { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.knowledge-editor-section { display: grid; gap: 12px; min-width: 0; margin: 0; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.knowledge-editor-section legend { padding: 0 6px; font-size: 12px; font-weight: 600; }
.knowledge-warning { padding: 8px 10px; border-radius: var(--radius-control); color: var(--color-warning); background: var(--color-warning-soft); font-size: 12px; }
.knowledge-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 820px) {
  .knowledge-edit-columns, .knowledge-field-row { grid-template-columns: 1fr; }
  .knowledge-edit-columns > section + section { padding: 18px 0 0; border-left: 0; border-top: 1px solid var(--color-border); }
}
</style>
