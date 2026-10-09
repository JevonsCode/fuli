<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { putJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
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
const sourceKindOptions = computed(() => SOURCE_KIND_VALUES.map((value) => ({
  value,
  label: value === 'prd' ? 'PRD' : t(`projects.profileDialog.sourceTypes.${value}`),
})))
const lifecycleOptions = computed(() => (['planned', 'active', 'maintenance', 'archived'] as const)
  .map((value) => ({ value, label: t(`projects.profileDialog.lifecycles.${value}`) })))
const SENSITIVITY_VALUES = ['normal', 'private', 'restricted'] as const
const sensitivityOptions = computed(() => SENSITIVITY_VALUES
  .map((value) => ({ value, label: t(`projects.profileDialog.sensitivities.${value}`) })))

const sourceKindValues = new Set<string>(SOURCE_KIND_VALUES)
const sensitivityValues = new Set<string>(SENSITIVITY_VALUES)

watch(
  () => [props.project, props.materialType] as const,
  ([project]) => {
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
</script>

<template>
  <UiDialog v-if="project" open class="project-profile-dialog" size="lg" form :busy="busy" :error="error"
    :title="t('projects.profileDialog.title', { material: materialLabel })" :description="t('projects.profileDialog.intro')"
    @close="emit('close')" @submit="save">
    <div class="project-profile-fields">
      <label class="ui-field">{{ t('projects.profileDialog.projectName') }}
        <input v-model="name" name="project-name" maxlength="160" required />
      </label>
      <UiSelect v-model="lifecycle" field name="project-lifecycle" :label="t('projects.profileDialog.lifecycle')" :options="lifecycleOptions" />
      <label class="ui-field project-profile-wide-field">{{ t('projects.profileDialog.purpose') }}
        <textarea v-model="purpose" name="project-purpose" maxlength="4096" rows="4" :autofocus="materialType === 'ProjectPurpose'" :placeholder="t('projects.profileDialog.purposePlaceholder')" />
      </label>
      <label class="ui-field project-profile-wide-field">{{ t('projects.profileDialog.scope') }}
        <textarea v-model="scope" name="project-scope" maxlength="4096" rows="4" :autofocus="materialType === 'ProjectScope'" :placeholder="t('projects.profileDialog.scopePlaceholder')" />
      </label>
      <label class="ui-field project-profile-wide-field">{{ t('projects.profileDialog.technicalSummary') }}
        <textarea v-model="technicalSummary" name="project-technical-summary" maxlength="4096" rows="4" :placeholder="t('projects.profileDialog.technicalPlaceholder')" />
      </label>
      <label class="ui-field project-profile-wide-field">{{ t('projects.profileDialog.boundary') }}
        <textarea v-model="boundaries" name="project-boundaries" maxlength="8192" rows="5" :autofocus="materialType === 'ProjectBoundary'" :placeholder="t('projects.profileDialog.boundaryPlaceholder')" />
        <small class="ui-field-hint">{{ t('projects.profileDialog.boundaryHint') }}</small>
      </label>
    </div>

    <section class="project-source-editor">
      <div class="project-source-editor-heading" tabindex="-1" :autofocus="materialType === 'ProjectSource'">
        <div>
          <h3>{{ t('projects.profileDialog.sources') }}</h3>
          <p class="ui-meta">{{ t('projects.profileDialog.sourcesCopy') }}</p>
        </div>
        <UiButton size="sm" @click="addSource">{{ t('projects.profileDialog.addSource') }}</UiButton>
      </div>
      <div v-if="sources.length" class="project-source-list">
        <article v-for="(source, index) in sources" :key="source.key" class="project-source-row">
          <label class="ui-field">{{ t('projects.profileDialog.sourceName') }}
            <input v-model="source.title" maxlength="512" required />
          </label>
          <UiSelect v-model="source.kind" field :label="t('projects.profileDialog.sourceType')" :options="sourceKindOptions" />
          <label class="ui-field project-source-wide-field">{{ t('projects.profileDialog.sourceUri') }}
            <input v-model="source.uri" maxlength="2048" :placeholder="t('projects.profileDialog.sourceUriPlaceholder')" />
          </label>
          <label class="ui-field project-source-wide-field">{{ t('projects.profileDialog.sourceSummary') }}
            <textarea v-model="source.summary" maxlength="4096" rows="2" />
          </label>
          <UiSelect v-model="source.sensitivity" field :label="t('projects.profileDialog.sensitivity')" :options="sensitivityOptions" />
          <UiButton class="project-source-remove" size="sm" variant="danger" @click="removeSource(index)">{{ t('common.actions.remove') }}</UiButton>
        </article>
      </div>
      <p v-else class="ui-meta">{{ t('projects.profileDialog.noSources') }}</p>
    </section>

    <p class="ui-meta">{{ t('projects.profileDialog.stateBoundary') }}</p>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" :busy="busy" :busy-label="t('projects.profileDialog.saving')">{{ t('projects.profileDialog.save') }}</UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.project-profile-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.project-profile-wide-field { grid-column: 1 / -1; }
.project-source-editor { display: grid; gap: 12px; padding-top: 16px; border-top: 1px solid var(--color-border); }
.project-source-editor-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; outline: 0; }
.project-source-editor-heading h3 { margin: 0; font-size: 13px; font-weight: 600; }
.project-source-editor-heading p { margin: 2px 0 0; }
.project-source-list { display: grid; gap: 10px; }
.project-source-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; gap: 10px; padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.project-source-wide-field { grid-column: 1 / span 2; }
.project-source-remove { justify-self: end; }
@media (max-width: 640px) {
  .project-profile-fields, .project-source-row { grid-template-columns: 1fr; }
  .project-source-wide-field { grid-column: auto; }
}
</style>
