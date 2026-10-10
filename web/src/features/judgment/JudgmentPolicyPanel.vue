<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'

import { judgmentText } from './judgment-copy'
import { loadJudgmentPolicy, saveJudgmentPolicy } from './judgment-api'
import {
  DEFAULT_JUDGMENT_POLICY,
  normalizeJudgmentPolicy,
  policySelection,
  type JudgmentClient,
  type JudgmentMode,
  type JudgmentPolicy,
  type JudgmentPolicySelection,
  type JudgmentProjectOption,
  type JudgmentQuality,
} from './judgment-types'

const props = withDefaults(defineProps<{
  personalSpaceId: string
  projects?: JudgmentProjectOption[]
}>(), { projects: () => [] })

const selectedProjectId = ref('')
const policy = ref<JudgmentPolicy | null>(null)
const draft = ref<JudgmentPolicySelection>({ ...DEFAULT_JUDGMENT_POLICY })
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const saveError = ref('')
const saved = ref(false)
const undoValue = ref<{ policy: JudgmentPolicySelection | null } | null>(null)
let generation = 0

const projectOptions = computed(() => [
  { id: '', name: judgmentText('settings.global') },
  ...props.projects.filter(project => project.id),
])
const projectScope = computed(() => selectedProjectId.value || null)
const projectOverride = computed(() => Boolean(projectScope.value && policy.value && !policy.value.inherited))
const busy = computed(() => loading.value || saving.value)
const canEdit = computed(() => Boolean(policy.value && !loadError.value && !saving.value))
const effectiveStatus = computed(() => {
  if (!projectScope.value || !policy.value) return ''
  return policy.value.inherited
    ? judgmentText('settings.inherited')
    : judgmentText('settings.override')
})

watch(() => props.projects, projects => {
  if (selectedProjectId.value && !projects.some(project => project.id === selectedProjectId.value)) selectedProjectId.value = ''
}, { deep: true })

watch([() => props.personalSpaceId, selectedProjectId], () => { void loadPolicy() }, { immediate: true })

async function loadPolicy() {
  const current = ++generation
  policy.value = null
  undoValue.value = null
  draft.value = { ...DEFAULT_JUDGMENT_POLICY }
  saving.value = false
  saved.value = false
  loadError.value = ''
  saveError.value = ''
  if (!props.personalSpaceId) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    const value = await loadJudgmentPolicy(props.personalSpaceId, projectScope.value)
    if (current !== generation) return
    policy.value = normalizeJudgmentPolicy(value)
    draft.value = policySelection(policy.value)
  } catch (cause) {
    if (current === generation) loadError.value = cause instanceof Error ? cause.message : judgmentText('settings.loadError')
  } finally {
    if (current === generation) loading.value = false
  }
}

function statusCode(cause: unknown) {
  return cause && typeof cause === 'object' && 'status' in cause && typeof (cause as { status?: unknown }).status === 'number'
    ? (cause as { status: number }).status
    : null
}

async function persist(next: JudgmentPolicySelection | null, undoing = false) {
  if (!policy.value || !canEdit.value) return
  saving.value = true
  saved.value = false
  saveError.value = ''
  const current = generation
  const previous = policy.value.inherited ? null : policySelection(policy.value)
  try {
    const value = await saveJudgmentPolicy(
      props.personalSpaceId,
      projectScope.value,
      next,
      policy.value.revision,
    )
    if (current !== generation) return
    policy.value = normalizeJudgmentPolicy(value)
    draft.value = policySelection(policy.value)
    saved.value = true
    undoValue.value = undoing ? null : { policy: previous }
  } catch (cause) {
    if (current !== generation) return
    if (statusCode(cause) === 409) {
      const reloading = generation + 1
      await loadPolicy()
      if (generation === reloading) saveError.value = judgmentText('settings.conflictError')
    } else saveError.value = cause instanceof Error ? cause.message : judgmentText('settings.saveError')
  } finally {
    if (current === generation) saving.value = false
  }
}

function save() { return persist({ ...draft.value }) }

function undo() {
  if (undoValue.value) return persist(undoValue.value.policy, true)
}

async function resetOverride() {
  if (projectOverride.value) return persist(null)
}

</script>

<template>
  <section class="judgment-policy-panel" :aria-label="judgmentText('settings.title')">
    <header class="judgment-panel-heading">
      <div>
        <h3>{{ judgmentText('settings.title') }}</h3>
        <p>{{ judgmentText('settings.hint') }}</p>
      </div>
      <GrowthLoading v-if="saving" variant="inline" :label="judgmentText('settings.saving')" />
    </header>

    <GrowthLoading v-if="loading && !policy" variant="compact" :label="judgmentText('settings.loading')" />
    <div v-else-if="!props.personalSpaceId" class="judgment-policy-empty">
      {{ judgmentText('settings.loadError') }}
    </div>
    <template v-else>
      <div v-if="props.projects.length" class="judgment-project-field">
        <label for="judgment-project-select">{{ judgmentText('settings.project') }}</label>
        <select id="judgment-project-select" data-select="judgment-project" v-model="selectedProjectId" :disabled="busy">
          <option v-for="project in projectOptions" :key="project.id || 'global'" :value="project.id">{{ project.name }}</option>
        </select>
        <small v-if="effectiveStatus" :class="{ 'is-inherited': policy?.inherited }">{{ effectiveStatus }}</small>
      </div>

      <div v-if="loadError" class="judgment-policy-error" role="alert">
        <span>{{ loadError }}</span>
        <button type="button" class="quiet-button" :disabled="busy" @click="loadPolicy">{{ judgmentText('settings.retry') }}</button>
      </div>
      <fieldset v-else-if="policy" class="judgment-policy-fields" :disabled="!canEdit">
        <legend>{{ judgmentText('mode.title') }}</legend>
        <label v-for="mode in (['manual', 'shared', 'autonomous'] as JudgmentMode[])" :key="mode" class="judgment-mode-option" :class="{ 'is-selected': draft.mode === mode }">
          <input v-model="draft.mode" type="radio" name="judgment-mode" :value="mode" @change="save()" />
          <span><strong>{{ judgmentText(`mode.${mode}`) }}</strong><small>{{ judgmentText(`mode.${mode}Hint`) }}</small></span>
        </label>

        <div v-if="draft.mode !== 'manual'" class="judgment-progressive-fields">
          <label>
            <span>{{ judgmentText('quality.title') }}</span>
            <select v-model="draft.quality" data-select="judgment-quality" @change="save()">
              <option v-for="quality in (['quality', 'balanced', 'economy'] as JudgmentQuality[])" :key="quality" :value="quality">{{ judgmentText(`quality.${quality}`) }}</option>
            </select>
          </label>
          <label>
            <span>{{ judgmentText('client.title') }}</span>
            <select v-model="draft.client" data-select="judgment-client" @change="save()">
              <option v-for="client in (['codex', 'claude_code'] as JudgmentClient[])" :key="client" :value="client">{{ judgmentText(`client.${client}`) }}</option>
            </select>
          </label>
        </div>

        <div class="judgment-policy-actions">
          <button v-if="saveError" class="quiet-button" type="button" data-action="save-policy" :disabled="busy" @click="save">
            {{ judgmentText('settings.retry') }}
          </button>
          <button v-if="projectOverride" class="quiet-button" type="button" data-action="reset-policy" :title="judgmentText('settings.resetTitle')" :disabled="busy" @click="resetOverride">
            {{ judgmentText('settings.reset') }}
          </button>
          <button v-if="undoValue" class="quiet-button" type="button" data-action="undo-policy" :disabled="busy" @click="undo">{{ judgmentText('settings.undo') }}</button>
          <span v-if="saved" class="judgment-policy-saved" role="status">{{ judgmentText('settings.saved') }}</span>
        </div>
      </fieldset>
      <div v-if="saveError" class="judgment-policy-error" role="alert">{{ saveError }}</div>
    </template>
  </section>
</template>

<style scoped>
.judgment-policy-panel { display: grid; gap: 18px; }
.judgment-panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.judgment-panel-heading h3 { margin: 0; color: var(--color-ink); font-size: 16px; }
.judgment-panel-heading p { margin: 6px 0 0; color: var(--color-muted); font-size: 13px; line-height: 1.55; }
.judgment-project-field { display: grid; grid-template-columns: minmax(130px, .45fr) minmax(180px, 1fr) auto; align-items: center; gap: 10px; }
.judgment-project-field label, .judgment-progressive-fields label > span { color: var(--color-muted); font-size: 12px; }
.judgment-project-field select, .judgment-progressive-fields select { min-height: var(--control-height); padding: 7px 10px; border: 1px solid var(--color-control-border); border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface); font: inherit; }
.judgment-project-field small { color: var(--color-muted); font-size: 12px; white-space: nowrap; }
.judgment-project-field small.is-inherited { color: var(--color-accent); }
.judgment-policy-fields { display: grid; gap: 10px; min-width: 0; padding: 0; border: 0; }
.judgment-policy-fields legend { margin-bottom: 2px; color: var(--color-muted); font-size: 12px; }
.judgment-mode-option { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); cursor: pointer; }
.judgment-mode-option.is-selected { border-color: var(--color-accent); background: var(--color-accent-soft); }
.judgment-mode-option input { margin-top: 3px; accent-color: var(--color-accent); }
.judgment-mode-option span { display: grid; gap: 3px; }
.judgment-mode-option strong { color: var(--color-ink); font-size: 13px; }
.judgment-mode-option small { color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.judgment-progressive-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 3px; padding: 12px; border-left: 2px solid var(--color-accent); background: var(--color-surface-subtle); }
.judgment-progressive-fields label { display: grid; gap: 6px; }
.judgment-policy-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 4px; }
.judgment-policy-saved { color: var(--color-muted); font-size: 12px; }
.judgment-policy-error { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-danger-soft); font-size: 13px; }
.judgment-policy-empty { color: var(--color-muted); font-size: 13px; }
@media (max-width: 640px) { .judgment-project-field { grid-template-columns: 1fr; align-items: stretch; }.judgment-progressive-fields { grid-template-columns: 1fr; } }
</style>
