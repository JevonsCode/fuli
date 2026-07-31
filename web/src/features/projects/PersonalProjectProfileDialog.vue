<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import { putJson } from '@/api/client'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'

type SourceDraft = {
  key: string
  kind: string
  title: string
  uri: string
  summary: string
  sensitivity: string
}

const props = defineProps<{
  project: PersonalProject | null
  materialType?: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: [project: PersonalProject]
}>()

const name = ref('')
const purpose = ref('')
const scope = ref('')
const technicalSummary = ref('')
const lifecycle = ref('planned')
const boundaries = ref('')
const sources = ref<SourceDraft[]>([])
const error = ref('')
const busy = ref(false)
const purposeField = ref<HTMLTextAreaElement | null>(null)
const scopeField = ref<HTMLTextAreaElement | null>(null)
const boundariesField = ref<HTMLTextAreaElement | null>(null)
const sourcesHeading = ref<HTMLElement | null>(null)

const materialTypes = new Set([
  'ProjectPurpose',
  'ProjectScope',
  'ProjectSource',
  'ProjectBoundary',
  'ProjectAssessment',
  'AssessmentDimension',
  'PersonalProject',
  'RelatedPersonalProject',
])
const materialLabel = computed(() => {
  const type = props.materialType ?? ''
  return materialTypes.has(type)
    ? t(`projects.profileDialog.materialTypes.${type}`)
    : t('projects.profileDialog.materialTypes.fallback')
})

const SOURCE_KIND_VALUES = [
  'prd',
  'product_document',
  'technical_document',
  'frontend_repository',
  'backend_repository',
  'repository',
  'design',
  'runbook',
  'monitoring',
  'issue_tracker',
  'other',
] as const
const sourceKinds = computed(() =>
  SOURCE_KIND_VALUES.map((value) => [
    value,
    value === 'prd' ? 'PRD' : t(`projects.profileDialog.sourceTypes.${value}`),
  ] as const),
)

const sourceKindValues = new Set<string>(SOURCE_KIND_VALUES)
const sensitivityValues = new Set(['normal', 'private', 'restricted'])

watch(
  () => [props.project, props.materialType] as const,
  async ([project]) => {
    if (!project) return
    const profile = project.profile
    name.value = profile.name
    purpose.value = profile.purpose ?? ''
    scope.value = profile.scope ?? ''
    technicalSummary.value = profile.technical_summary ?? ''
    lifecycle.value = profile.lifecycle ?? 'planned'
    boundaries.value = (profile.boundaries ?? [])
      .map((boundary) => String(boundary))
      .join('\n')
    sources.value = (profile.sources ?? []).map(normalizeSource)
    error.value = ''
    await nextTick()
    focusRelevantField()
  },
  { immediate: true },
)

function normalizeSource(source: Record<string, unknown>, index: number): SourceDraft {
  const kind = typeof source.kind === 'string' && sourceKindValues.has(source.kind)
    ? source.kind
    : 'other'
  const sensitivity = typeof source.sensitivity === 'string'
    && sensitivityValues.has(source.sensitivity)
    ? source.sensitivity
    : 'normal'
  return {
    key: text(source.key) || `source-${index + 1}`,
    kind,
    title: text(source.title) || text(source.name),
    uri: text(source.uri),
    summary: text(source.summary),
    sensitivity,
  }
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function nullable(value: string) {
  return value.trim() || null
}

function boundaryLines() {
  return [...new Set(
    boundaries.value
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  )].slice(0, 64)
}

function addSource() {
  sources.value.push({
    key: `source-${Date.now().toString(36)}-${sources.value.length + 1}`,
    kind: 'other',
    title: '',
    uri: '',
    summary: '',
    sensitivity: 'normal',
  })
}

function removeSource(index: number) {
  sources.value.splice(index, 1)
}

async function save() {
  if (!props.project || busy.value) return
  const projectName = name.value.trim()
  if (!projectName) {
    error.value = t('projects.profileDialog.errors.nameRequired')
    return
  }
  if (sources.value.some((source) => !source.title.trim())) {
    error.value = t('projects.profileDialog.errors.sourceNameRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const saved = await putJson<PersonalProject>('/api/personal-projects', {
      personalSpaceId: props.project.personal_space_id,
      projectId: props.project.project_id,
      profile: {
        name: projectName,
        purpose: nullable(purpose.value),
        scope: nullable(scope.value),
        technicalSummary: nullable(technicalSummary.value),
        lifecycle: lifecycle.value,
        sources: sources.value.map((source) => ({
          key: source.key,
          kind: source.kind,
          title: source.title.trim(),
          uri: nullable(source.uri),
          summary: nullable(source.summary),
          sensitivity: source.sensitivity,
        })),
        boundaries: boundaryLines(),
        assessment: props.project.profile.assessment ?? null,
      },
    })
    emit('saved', saved)
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error
      ? cause.message
      : t('projects.profileDialog.errors.saveFailed')
  } finally {
    busy.value = false
  }
}

function focusRelevantField() {
  if (props.materialType === 'ProjectPurpose') purposeField.value?.focus()
  else if (props.materialType === 'ProjectScope') scopeField.value?.focus()
  else if (props.materialType === 'ProjectBoundary') boundariesField.value?.focus()
  else if (props.materialType === 'ProjectSource') sourcesHeading.value?.focus()
}
</script>

<template>
  <dialog v-if="project" open class="project-profile-dialog vue-dialog">
    <form class="project-profile-dialog-shell" @submit.prevent="save">
      <header class="project-profile-dialog-header">
        <div>
          <p class="eyebrow">PROJECT MATERIAL</p>
          <h3>{{ t('projects.profileDialog.title', { material: materialLabel }) }}</h3>
          <p>{{ t('projects.profileDialog.intro') }}</p>
        </div>
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          {{ t('common.actions.close') }}
        </button>
      </header>

      <div class="project-profile-fields">
        <label>
          <span>{{ t('projects.profileDialog.projectName') }}</span>
          <input v-model="name" name="project-name" maxlength="160" required />
        </label>
        <label>
          <span>{{ t('projects.profileDialog.lifecycle') }}</span>
          <select v-model="lifecycle" name="project-lifecycle">
            <option value="planned">{{ t('projects.profileDialog.lifecycles.planned') }}</option>
            <option value="active">{{ t('projects.profileDialog.lifecycles.active') }}</option>
            <option value="maintenance">{{ t('projects.profileDialog.lifecycles.maintenance') }}</option>
            <option value="archived">{{ t('projects.profileDialog.lifecycles.archived') }}</option>
          </select>
        </label>
        <label class="project-profile-wide-field">
          <span>{{ t('projects.profileDialog.purpose') }}</span>
          <textarea
            ref="purposeField"
            v-model="purpose"
            name="project-purpose"
            maxlength="4096"
            rows="4"
            :placeholder="t('projects.profileDialog.purposePlaceholder')"
          />
        </label>
        <label class="project-profile-wide-field">
          <span>{{ t('projects.profileDialog.scope') }}</span>
          <textarea
            ref="scopeField"
            v-model="scope"
            name="project-scope"
            maxlength="4096"
            rows="4"
            :placeholder="t('projects.profileDialog.scopePlaceholder')"
          />
        </label>
        <label class="project-profile-wide-field">
          <span>{{ t('projects.profileDialog.technicalSummary') }}</span>
          <textarea
            v-model="technicalSummary"
            name="project-technical-summary"
            maxlength="4096"
            rows="4"
            :placeholder="t('projects.profileDialog.technicalPlaceholder')"
          />
        </label>
        <label class="project-profile-wide-field">
          <span>{{ t('projects.profileDialog.boundary') }}</span>
          <textarea
            ref="boundariesField"
            v-model="boundaries"
            name="project-boundaries"
            maxlength="8192"
            rows="5"
            :placeholder="t('projects.profileDialog.boundaryPlaceholder')"
          />
          <small>{{ t('projects.profileDialog.boundaryHint') }}</small>
        </label>
      </div>

      <section class="project-source-editor">
        <div ref="sourcesHeading" class="project-source-editor-heading" tabindex="-1">
          <div>
            <h4>{{ t('projects.profileDialog.sources') }}</h4>
            <p>{{ t('projects.profileDialog.sourcesCopy') }}</p>
          </div>
          <button class="secondary-action" type="button" @click="addSource">{{ t('projects.profileDialog.addSource') }}</button>
        </div>
        <div v-if="sources.length" class="project-source-list">
          <article v-for="(source, index) in sources" :key="source.key" class="project-source-row">
            <label>
              <span>{{ t('projects.profileDialog.sourceName') }}</span>
              <input v-model="source.title" maxlength="512" required />
            </label>
            <label>
              <span>{{ t('projects.profileDialog.sourceType') }}</span>
              <select v-model="source.kind">
                <option v-for="[value, label] in sourceKinds" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </label>
            <label class="project-source-wide-field">
              <span>{{ t('projects.profileDialog.sourceUri') }}</span>
              <input v-model="source.uri" maxlength="2048" :placeholder="t('projects.profileDialog.sourceUriPlaceholder')" />
            </label>
            <label class="project-source-wide-field">
              <span>{{ t('projects.profileDialog.sourceSummary') }}</span>
              <textarea v-model="source.summary" maxlength="4096" rows="2" />
            </label>
            <label>
              <span>{{ t('projects.profileDialog.sensitivity') }}</span>
              <select v-model="source.sensitivity">
                <option value="normal">{{ t('projects.profileDialog.sensitivities.normal') }}</option>
                <option value="private">{{ t('projects.profileDialog.sensitivities.private') }}</option>
                <option value="restricted">{{ t('projects.profileDialog.sensitivities.restricted') }}</option>
              </select>
            </label>
            <button class="text-action project-source-remove" type="button" @click="removeSource(index)">
              {{ t('common.actions.remove') }}
            </button>
          </article>
        </div>
        <p v-else class="project-source-empty">{{ t('projects.profileDialog.noSources') }}</p>
      </section>

      <p class="project-profile-state-note">
        {{ t('projects.profileDialog.stateBoundary') }}
      </p>
      <p v-if="error" class="project-profile-error" role="alert">{{ error }}</p>
      <footer class="project-profile-dialog-actions">
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          {{ t('common.actions.cancel') }}
        </button>
        <button class="primary-action" type="submit" :disabled="busy">
          {{ busy ? t('projects.profileDialog.saving') : t('projects.profileDialog.save') }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
