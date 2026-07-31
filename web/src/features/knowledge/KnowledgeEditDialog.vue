<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'

import { patchJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { t } from '@/i18n'
import { quadrantLabel } from './model'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeEdge, KnowledgeItem, KnowledgeNode, PersonalProject } from '@/types'

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
  await execute(async () => {
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
  await execute(async () => {
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
  await execute(async () => {
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
  await execute(async () => {
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
  await execute(async () => {
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

async function execute(operation: () => Promise<void>) {
  busy.value = true
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
  }
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <dialog v-if="item" open class="project-dialog knowledge-edit-dialog vue-dialog">
    <div class="project-dialog-shell">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">PERSONAL KNOWLEDGE</p>
          <h3>{{ invalid
            ? t('knowledge.dialogs.edit.titleRestore')
            : t('knowledge.dialogs.edit.titleCorrect') }}</h3>
          <p>{{ t('knowledge.dialogs.edit.intro') }}</p>
        </div>
        <button class="secondary-action" type="button" @click="emit('close')">{{ t('common.actions.close') }}</button>
      </header>

      <div class="knowledge-edit-columns">
        <section>
          <h4>{{ t('knowledge.dialogs.edit.currentContent') }}</h4>
          <form class="knowledge-editor-form" @submit.prevent="saveCorrection">
            <label v-if="!relationship">{{ t('knowledge.dialogs.edit.name') }}<input v-model="form.name" maxlength="512" /></label>
            <label v-if="!relationship">{{ t('knowledge.dialogs.edit.description') }}<textarea v-model="form.summary" maxlength="4096" rows="5" /></label>
            <label v-else>{{ t('knowledge.dialogs.edit.fact') }}<textarea v-model="form.fact" maxlength="8192" rows="5" /></label>
            <div class="knowledge-taxonomy-fields">
              <label>{{ t('knowledge.dialogs.edit.classification') }}
                <SearchableSelect
                  v-model="form.currentQuadrant"
                  :options="quadrantOptions"
                  :label="t('knowledge.dialogs.edit.classification')"
                />
              </label>
              <label>{{ t('knowledge.dialogs.edit.confirmationStatus') }}
                <SearchableSelect
                  v-model="form.confirmationStatus"
                  :options="confirmationStatusOptions"
                  :label="t('knowledge.dialogs.edit.confirmationStatus')"
                />
              </label>
              <label>{{ t('knowledge.dialogs.edit.preferenceDimension') }}
                <SearchableSelect
                  v-model="form.profileAspect"
                  :options="profileAspectOptions"
                  :label="t('knowledge.dialogs.edit.preferenceDimension')"
                />
              </label>
            </div>
            <p class="knowledge-classification-warning">
              {{ t('knowledge.dialogs.edit.originQuadrant', {
                quadrant: quadrantLabel(item.originQuadrant),
              }) }}
            </p>
            <p v-if="!item.classificationExplicit" class="knowledge-classification-warning">
              {{ t('knowledge.dialogs.edit.missingQuadrant') }}
            </p>
            <fieldset class="knowledge-confirmation-fields">
              <legend>{{ t('knowledge.dialogs.edit.basis') }}</legend>
              <label>{{ t('knowledge.dialogs.edit.whyExists') }}
                <textarea v-model="form.existenceReason" maxlength="4096" rows="3" required />
              </label>
              <label>{{ t('knowledge.dialogs.edit.whyQuadrant') }}
                <textarea v-model="form.quadrantReason" maxlength="4096" rows="3" required />
              </label>
              <div class="knowledge-taxonomy-fields">
                <label>{{ t('knowledge.dialogs.edit.proposer') }}
                  <SearchableSelect
                    v-model="form.proposedByKind"
                    :options="proposerOptions"
                    :label="t('knowledge.dialogs.edit.proposer')"
                  />
                </label>
                <label>{{ t('knowledge.dialogs.edit.proposerDescription') }}
                  <input v-model="form.proposedByLabel" maxlength="160" :placeholder="t('knowledge.dialogs.edit.proposerPlaceholder')" />
                </label>
                <template v-if="form.confirmationStatus === 'confirmed'">
                  <label>{{ t('knowledge.dialogs.edit.confirmer') }}
                    <SearchableSelect
                      v-model="form.confirmedByKind"
                      :options="confirmerOptions"
                      :label="t('knowledge.dialogs.edit.confirmer')"
                    />
                  </label>
                  <label>{{ t('knowledge.dialogs.edit.confirmerDescription') }}
                    <input v-model="form.confirmedByLabel" maxlength="160" :placeholder="t('knowledge.dialogs.edit.confirmerPlaceholder')" />
                  </label>
                </template>
              </div>
              <p>
                {{ t('knowledge.dialogs.edit.agentConfirmedBoundary') }}
              </p>
            </fieldset>
            <fieldset v-if="!profilePreference" class="knowledge-replacement-fields">
              <legend>{{ t('knowledge.dialogs.edit.crossProjectInheritance') }}</legend>
              <label>{{ t('knowledge.dialogs.edit.inheritanceScope') }}
                <SearchableSelect
                  v-model="form.inheritanceMode"
                  :options="inheritanceModeOptions"
                  :label="t('knowledge.dialogs.edit.inheritanceScope')"
                />
              </label>
              <label v-if="form.inheritanceMode === 'selected_projects'">{{ t('knowledge.dialogs.edit.inheritedProjects') }}
                <SearchableSelect
                  v-model="inheritanceProjectId"
                  :options="projectOptions"
                  :label="t('knowledge.dialogs.edit.inheritedProjects')"
                  searchable
                />
              </label>
              <p>
                {{ t('knowledge.dialogs.edit.inheritanceBoundary') }}
              </p>
            </fieldset>
            <fieldset class="knowledge-replacement-fields">
              <legend>{{ invalid
                ? t('knowledge.dialogs.edit.replacement')
                : t('knowledge.dialogs.edit.optionalReplacement') }}</legend>
              <label>{{ invalid
                ? t('knowledge.dialogs.edit.historicalReplacement')
                : t('knowledge.dialogs.edit.activeReplacement') }}
                <SearchableSelect
                  v-model="replacementItemKey"
                  :options="replacementOptions"
                  :label="t('knowledge.dialogs.edit.replacement')"
                  searchable
                />
              </label>
              <p>
                {{ t('knowledge.dialogs.edit.replacementBoundary') }}
              </p>
            </fieldset>
            <label>{{ t('knowledge.dialogs.edit.correctionReason') }}<textarea v-model="form.reason" maxlength="2000" rows="3" required /></label>
            <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
            <div class="knowledge-editor-actions">
              <button v-if="!invalid" class="secondary-action" type="button" :disabled="busy" @click="changeStatus('invalidate')">{{ t('knowledge.dialogs.edit.invalidate') }}</button>
              <template v-else>
                <button class="secondary-action" type="button" :disabled="busy" @click="changeStatus('restore')">{{ t('knowledge.dialogs.edit.restore') }}</button>
                <button class="secondary-action" type="button" :disabled="busy" @click="saveReplacement">{{ t('knowledge.dialogs.edit.saveReplacement') }}</button>
              </template>
              <button class="primary-action" type="submit" :disabled="busy">
                {{ busy
                  ? t('knowledge.dialogs.edit.saving')
                  : form.confirmationStatus === 'confirmed'
                    ? t('knowledge.dialogs.edit.saveConfirmed')
                    : t('knowledge.dialogs.edit.savePending') }}
              </button>
            </div>
          </form>
        </section>

        <section v-if="!profilePreference">
          <h4>{{ t('knowledge.dialogs.edit.projectOwnership') }}</h4>
          <p>{{ t('knowledge.dialogs.edit.ownershipCopy') }}</p>
          <form class="knowledge-editor-form" @submit.prevent="saveAssignment">
            <label>{{ t('knowledge.dialogs.edit.targetProject') }}
              <SearchableSelect
                v-model="targetProjectId"
                :options="projectOptions"
                :label="t('knowledge.dialogs.edit.targetProject')"
                searchable
                required
              />
            </label>
            <label>{{ t('knowledge.dialogs.edit.assignmentReason') }}<textarea v-model="assignmentReason" maxlength="2000" rows="3" required /></label>
            <button class="primary-action" type="submit" :disabled="busy || projects.length === 0">{{ t('knowledge.dialogs.edit.adjustOwnership') }}</button>
          </form>
        </section>

        <section v-else>
          <h4>{{ t('knowledge.dialogs.edit.preferenceScope') }}</h4>
          <p>{{ t('knowledge.dialogs.edit.preferenceScopeCopy') }}</p>
          <form class="knowledge-editor-form" @submit.prevent="savePreferenceScope">
            <label>{{ t('knowledge.dialogs.edit.effectiveScope') }}
              <SearchableSelect
                v-model="preferenceScope"
                :options="preferenceScopeOptions"
                :label="t('knowledge.dialogs.edit.preferenceScope')"
              />
            </label>
            <label v-if="preferenceScope === 'project'">{{ t('knowledge.dialogs.edit.personalProject') }}
              <SearchableSelect
                v-model="preferenceProjectId"
                :options="projectOptions"
                :label="t('knowledge.dialogs.edit.personalProject')"
                searchable
              />
            </label>
            <label>{{ t('knowledge.dialogs.edit.assignmentReason') }}<textarea v-model="preferenceReason" maxlength="2000" rows="3" required /></label>
            <button class="primary-action" type="submit" :disabled="busy">{{ t('knowledge.dialogs.edit.saveScope') }}</button>
          </form>
        </section>
      </div>
    </div>
  </dialog>
</template>
