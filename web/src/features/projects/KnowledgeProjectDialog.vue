<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem, KnowledgeNode, PersonalProject } from '@/types'

type ProjectMode = 'create' | 'existing'
type ConflictResolution = 'defer' | 'keep_target' | 'use_source' | 'coexist'
type RelationType =
  | 'RELATED_TO'
  | 'PART_OF'
  | 'USES_KNOWLEDGE_FROM'
  | 'DEPENDS_ON'
  | 'PROVIDES_TO'
  | 'SHARES_CAPABILITY_WITH'
  | 'SUCCESSOR_OF'

interface ProjectActionPreview {
  item_name: string
  item_summary?: string
  match: {
    kind: 'none' | 'already_linked' | 'exact_duplicate' | 'conflict'
    reason: string
    item_name?: string
    item_summary?: string
  }
}

interface ProjectActionResult {
  status:
    | 'created'
    | 'linked'
    | 'already_linked'
    | 'duplicate_reused'
    | 'conflict_pending'
    | 'conflict_resolved'
    | string
}

const props = defineProps<{
  item: KnowledgeItem | null
  personalSpaceId: string
  personalProjectId: string | null
  projects: PersonalProject[]
}>()

const emit = defineEmits<{
  close: []
  saved: [result: ProjectActionResult, targetName: string]
}>()

const store = useConsoleStore()
const mode = ref<ProjectMode>('create')
const targetProjectId = ref('')
const newProjectName = ref('')
const newProjectId = ref('')
const newProjectPurpose = ref('')
const keepSourceRelation = ref(true)
const relationType = ref<RelationType>('RELATED_TO')
const conflictResolution = ref<ConflictResolution>('defer')
const reason = ref('')
const preview = ref<ProjectActionPreview | null>(null)
const previewLoading = ref(false)
const busy = ref(false)
const localError = ref('')
const idTouched = ref(false)
let previewSequence = 0

const rawNode = computed(() =>
  props.item?.itemKind === 'entity' ? (props.item.raw as KnowledgeNode) : null,
)
const sourceProjectId = computed(() => {
  const assignment = props.item?.assignments.at(0) as { project_id?: string } | undefined
  return assignment?.project_id
    ?? props.item?.evidence.find(({ personal_project_id }) => personal_project_id)
      ?.personal_project_id
    ?? props.personalProjectId
    ?? null
})
const availableProjects = computed(() =>
  props.projects.filter(({ project_id }) => project_id !== sourceProjectId.value),
)
const availableProjectOptions = computed(() =>
  availableProjects.value.map((project) => ({
    value: project.project_id,
    label: project.profile.name,
    meta: `#${compactIdentity(project.project_id, 26)}`,
    search: identitySearchText(project.project_id),
  })),
)
const selectedProject = computed(() =>
  availableProjects.value.find(({ project_id }) => project_id === targetProjectId.value) ?? null,
)
const previewState = computed(() => {
  if (mode.value === 'create') {
    return {
      label: t('projects.knowledgeDialog.previews.create.label'),
      title: t('projects.knowledgeDialog.previews.create.title'),
      copy: sourceProjectId.value
        ? t('projects.knowledgeDialog.previews.create.linkedCopy')
        : t('projects.knowledgeDialog.previews.create.ownedCopy'),
    }
  }
  if (previewLoading.value) {
    return {
      label: t('projects.knowledgeDialog.previews.checking.label'),
      title: t('projects.knowledgeDialog.previews.checking.title'),
      copy: t('projects.knowledgeDialog.previews.checking.copy'),
    }
  }
  if (!preview.value) {
    return {
      label: t('projects.knowledgeDialog.previews.waiting.label'),
      title: t('projects.knowledgeDialog.previews.waiting.title'),
      copy: t('projects.knowledgeDialog.previews.waiting.copy'),
    }
  }
  const labels = Object.fromEntries(
    ['none', 'already_linked', 'exact_duplicate', 'conflict'].map((kind) => [
      kind,
      [
        t(`projects.knowledgeDialog.previews.outcomes.${kind}.title`),
        t(`projects.knowledgeDialog.previews.outcomes.${kind}.copy`),
      ],
    ]),
  ) as Record<ProjectActionPreview['match']['kind'], [string, string]>
  const [label, title] = labels[preview.value.match.kind] ?? labels.none
  return { label, title, copy: preview.value.match.reason }
})
const relationLabels = computed<Record<RelationType, string>>(() => {
  const subject = mode.value === 'existing'
    ? t('projects.knowledgeDialog.relationActors.sourceProject')
    : t('projects.knowledgeDialog.relationActors.newProject')
  const object = mode.value === 'existing'
    ? t('projects.knowledgeDialog.relationActors.targetProject')
    : t('projects.knowledgeDialog.relationActors.sourceProject')
  return {
    RELATED_TO: t('projects.knowledgeDialog.relations.related', { object }),
    PART_OF: t('projects.knowledgeDialog.relations.partOf', { subject, object }),
    USES_KNOWLEDGE_FROM: t('projects.knowledgeDialog.relations.usesKnowledge', {
      subject,
      object,
    }),
    DEPENDS_ON: t('projects.knowledgeDialog.relations.dependsOn', { subject, object }),
    PROVIDES_TO: t('projects.knowledgeDialog.relations.providesTo', { subject, object }),
    SHARES_CAPABILITY_WITH: t('projects.knowledgeDialog.relations.sharesCapability', {
      object,
    }),
    SUCCESSOR_OF: t('projects.knowledgeDialog.relations.successorOf', {
      subject,
      object,
    }),
  }
})
const relationOptions = computed(() =>
  (Object.entries(relationLabels.value) as Array<[RelationType, string]>)
    .map(([value, label]) => ({ value, label })),
)
const submitLabel = computed(() => {
  if (busy.value) return t('projects.knowledgeDialog.actions.processing')
  if (mode.value === 'create') return t('projects.knowledgeDialog.actions.create')
  return preview.value?.match.kind === 'exact_duplicate'
    ? t('projects.knowledgeDialog.actions.reuse')
    : t('projects.knowledgeDialog.actions.add')
})
const submitDisabled = computed(() =>
  busy.value
  || (mode.value === 'existing' && (previewLoading.value || !preview.value)),
)

watch(
  () => props.item,
  (item) => {
    previewSequence += 1
    preview.value = null
    previewLoading.value = false
    localError.value = ''
    mode.value = 'create'
    idTouched.value = false
    const node = item?.itemKind === 'entity' ? (item.raw as KnowledgeNode) : null
    newProjectName.value = node?.name ?? ''
    newProjectId.value = projectIdFrom(node?.name ?? '')
    newProjectPurpose.value = node?.summary ?? ''
    reason.value = node
      ? t('projects.knowledgeDialog.defaultReason', { name: node.name })
      : ''
    keepSourceRelation.value = true
    relationType.value = 'RELATED_TO'
    conflictResolution.value = 'defer'
    targetProjectId.value = availableProjects.value[0]?.project_id ?? ''
  },
  { immediate: true },
)

watch(newProjectName, (value) => {
  if (!idTouched.value) newProjectId.value = projectIdFrom(value)
})

watch(
  [mode, targetProjectId, () => props.item],
  () => {
    if (mode.value === 'existing') void loadPreview()
    else {
      previewSequence += 1
      preview.value = null
      previewLoading.value = false
      localError.value = ''
    }
  },
)

async function loadPreview() {
  const item = props.item
  if (!item || item.itemKind !== 'entity' || !targetProjectId.value) return
  const sequence = ++previewSequence
  previewLoading.value = true
  preview.value = null
  localError.value = ''
  try {
    const result = await postJson<ProjectActionPreview>(
      `/api/knowledge/entity/${encodeURIComponent(item.id)}/project-action/preview`,
      {
        personalSpaceId: props.personalSpaceId,
        targetProjectId: targetProjectId.value,
      },
    )
    if (sequence !== previewSequence || props.item?.id !== item.id) return
    preview.value = result
    if (result.match.kind === 'conflict') conflictResolution.value = 'defer'
  } catch (error) {
    if (sequence !== previewSequence) return
    fail(normalizeError(error))
    store.reportError(error)
  } finally {
    if (sequence === previewSequence) previewLoading.value = false
  }
}

async function submit() {
  const item = props.item
  if (!item || item.itemKind !== 'entity') return
  if (mode.value === 'create' && (!newProjectName.value.trim() || !newProjectId.value.trim())) {
    return fail(t('projects.knowledgeDialog.errors.projectIdentityRequired'))
  }
  if (mode.value === 'existing' && !targetProjectId.value) {
    return fail(t('projects.knowledgeDialog.errors.targetRequired'))
  }
  if (mode.value === 'existing' && !preview.value) {
    return fail(t('projects.knowledgeDialog.errors.previewRequired'))
  }
  if (!reason.value.trim()) return fail(t('projects.knowledgeDialog.errors.reasonRequired'))

  busy.value = true
  localError.value = ''
  try {
    const result = await postJson<ProjectActionResult>(
      `/api/knowledge/entity/${encodeURIComponent(item.id)}/project-action`,
      {
        personalSpaceId: props.personalSpaceId,
        mode: mode.value,
        targetProjectId: mode.value === 'existing' ? targetProjectId.value : null,
        newProjectId: mode.value === 'create' ? newProjectId.value.trim() : null,
        newProjectName: mode.value === 'create' ? newProjectName.value.trim() : null,
        newProjectPurpose: mode.value === 'create' ? newProjectPurpose.value.trim() : null,
        keepSourceRelation: Boolean(sourceProjectId.value && keepSourceRelation.value),
        relationType: relationType.value,
        conflictResolution: conflictResolution.value,
        reason: reason.value.trim(),
      },
    )
    const targetName = mode.value === 'create'
      ? newProjectName.value.trim()
      : selectedProject.value?.profile.name
        ?? t('projects.knowledgeDialog.relationActors.targetProject')
    emit('close')
    emit('saved', result, targetName)
  } catch (error) {
    fail(normalizeError(error))
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

function projectIdFrom(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
  return normalized || 'new-project'
}

function normalizeError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(text) as { message?: string; detail?: string }
    return parsed.message ?? parsed.detail ?? text
  } catch {
    return text
  }
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <dialog v-if="item" open class="project-dialog knowledge-project-dialog vue-dialog">
    <div class="project-dialog-shell">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">PERSONAL PROJECT</p>
          <h3>{{ t('projects.knowledgeDialog.title') }}</h3>
          <p>{{ t('projects.knowledgeDialog.intro') }}</p>
        </div>
        <button class="secondary-action" type="button" @click="emit('close')">{{ t('common.actions.close') }}</button>
      </header>

      <form class="knowledge-project-form" @submit.prevent="submit">
        <div class="knowledge-project-source">
          <span>{{ t('projects.knowledgeDialog.sourceNode') }}</span>
          <strong>{{ rawNode?.name }}</strong>
          <p>{{ rawNode?.summary || t('common.status.noDescription') }}</p>
        </div>

        <fieldset class="knowledge-project-mode">
          <legend>{{ t('projects.knowledgeDialog.chooseAction') }}</legend>
          <label>
            <input v-model="mode" type="radio" value="create" />
            <span><strong>{{ t('projects.knowledgeDialog.createNew') }}</strong><small>{{ t('projects.knowledgeDialog.createNewCopy') }}</small></span>
          </label>
          <label :class="{ disabled: availableProjects.length === 0 }">
            <input
              v-model="mode"
              type="radio"
              value="existing"
              :disabled="availableProjects.length === 0"
            />
            <span><strong>{{ t('projects.knowledgeDialog.addExisting') }}</strong><small>{{ t('projects.knowledgeDialog.addExistingCopy') }}</small></span>
          </label>
        </fieldset>

        <section v-if="mode === 'create'" class="knowledge-project-fields">
          <label>{{ t('projects.knowledgeDialog.projectName') }}
            <input v-model="newProjectName" maxlength="512" required />
          </label>
          <label>{{ t('projects.knowledgeDialog.projectId') }}
            <input
              v-model="newProjectId"
              maxlength="128"
              required
              @input="idTouched = true"
            />
          </label>
          <label class="full-width">{{ t('projects.knowledgeDialog.purpose') }}
            <textarea v-model="newProjectPurpose" maxlength="4096" rows="3" />
          </label>
        </section>

        <section v-else class="knowledge-project-fields">
          <label class="full-width">{{ t('projects.knowledgeDialog.targetPersonalProject') }}
            <SearchableSelect
              v-model="targetProjectId"
              :options="availableProjectOptions"
              :label="t('projects.knowledgeDialog.targetPersonalProject')"
              searchable
              required
            />
          </label>
        </section>

        <section v-if="sourceProjectId" class="knowledge-project-relation">
          <label class="toggle-row">
            <input v-model="keepSourceRelation" type="checkbox" />
            <span>
              <strong>{{ t('projects.knowledgeDialog.preserveRelation') }}</strong>
              <small>{{ t('projects.knowledgeDialog.preserveRelationCopy') }}</small>
            </span>
          </label>
          <label>{{ t('projects.knowledgeDialog.projectRelation') }}
            <SearchableSelect
              v-model="relationType"
              :options="relationOptions"
              :label="t('projects.knowledgeDialog.projectRelation')"
              :disabled="!keepSourceRelation"
            />
          </label>
        </section>

        <section class="knowledge-project-preview">
          <div>
            <span>{{ previewState.label }}</span>
            <strong>{{ previewState.title }}</strong>
            <p>{{ previewState.copy }}</p>
          </div>
          <div
            v-if="preview && ['exact_duplicate', 'conflict'].includes(preview.match.kind)"
            class="knowledge-project-compare"
          >
            <article>
              <span>{{ t('projects.knowledgeDialog.currentNode') }}</span>
              <strong>{{ preview.item_name }}</strong>
              <p>{{ preview.item_summary || t('common.status.noDescription') }}</p>
            </article>
            <article>
              <span>{{ t('projects.knowledgeDialog.targetContent') }}</span>
              <strong>{{ preview.match.item_name || t('projects.knowledgeDialog.targetContentFallback') }}</strong>
              <p>{{ preview.match.item_summary || t('common.status.noDescription') }}</p>
            </article>
          </div>
          <fieldset
            v-if="preview?.match.kind === 'conflict'"
            class="knowledge-project-conflict-options"
          >
            <legend>{{ t('projects.knowledgeDialog.conflictResolution') }}</legend>
            <label><input v-model="conflictResolution" type="radio" value="defer" /> {{ t('projects.knowledgeDialog.defer') }}</label>
            <label><input v-model="conflictResolution" type="radio" value="keep_target" /> {{ t('projects.knowledgeDialog.keepTarget') }}</label>
            <label><input v-model="conflictResolution" type="radio" value="use_source" /> {{ t('projects.knowledgeDialog.useSource') }}</label>
            <label><input v-model="conflictResolution" type="radio" value="coexist" /> {{ t('projects.knowledgeDialog.coexist') }}</label>
          </fieldset>
        </section>

        <label class="knowledge-project-reason">{{ t('projects.knowledgeDialog.operationReason') }}
          <textarea v-model="reason" maxlength="2048" rows="3" required />
        </label>
        <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
        <div class="knowledge-project-actions">
          <button class="secondary-action" type="button" @click="emit('close')">{{ t('common.actions.cancel') }}</button>
          <button class="primary-action" type="submit" :disabled="submitDisabled">
            {{ submitLabel }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>
