<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import { pickerOrder, projectDisplayName } from '@/features/projects/project-origin'
import type { PersonalProject } from '@/types'

import ProjectJudgmentPolicy from './ProjectJudgmentPolicy.vue'
import { judgmentText, policySummary } from './judgment-copy'
import { loadJudgmentPolicyOverrides, startProjectJudgmentPolicy } from './judgment-api'
import { normalizeJudgmentPolicy, type JudgmentPolicy } from './judgment-types'

// Tonborg's workbench: the projects that judge differently from Tonborg's
// default. Adding one starts it from the default; removing one (恢复默认)
// takes it off the list. The default itself is set in Settings.
const props = withDefaults(defineProps<{ personalSpaceId: string; projects?: PersonalProject[] }>(), { projects: () => [] })

const defaultPolicy = ref<JudgmentPolicy | null>(null)
const overrides = ref<JudgmentPolicy[]>([])
const loading = ref(false)
const adding = ref(false)
const error = ref('')
const chosenProjectId = ref('')
let generation = 0

const spaceProjects = computed(() => pickerOrder(props.projects
  .filter(project => project.personal_space_id === props.personalSpaceId && project.profile?.lifecycle !== 'archived')))
const projectName = (projectId: string) => {
  const project = spaceProjects.value.find(candidate => candidate.project_id === projectId)
  return project ? projectDisplayName(project) : projectId
}
const addable = computed(() => spaceProjects.value.filter(project => !overrides.value.some(policy => policy.personalProjectId === project.project_id)))
const addingLabel = computed(() => t('judgment.project.starting', { name: projectName(chosenProjectId.value) }))

watch(() => props.personalSpaceId, () => { void load() }, { immediate: true })
watch(addable, projects => {
  if (!projects.some(project => project.project_id === chosenProjectId.value)) chosenProjectId.value = projects[0]?.project_id ?? ''
}, { immediate: true })

async function load() {
  const current = ++generation
  error.value = ''
  defaultPolicy.value = null
  overrides.value = []
  if (!props.personalSpaceId) return
  loading.value = true
  try {
    const value = await loadJudgmentPolicyOverrides(props.personalSpaceId)
    if (current !== generation) return
    defaultPolicy.value = normalizeJudgmentPolicy(value.default)
    overrides.value = (value.overrides ?? []).map(policy => normalizeJudgmentPolicy(policy))
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : judgmentText('overrides.loadError')
  } finally {
    if (current === generation) loading.value = false
  }
}

async function add() {
  const projectId = chosenProjectId.value
  if (!projectId || adding.value) return
  const current = generation
  adding.value = true
  error.value = ''
  try {
    const value = normalizeJudgmentPolicy(await startProjectJudgmentPolicy(props.personalSpaceId, projectId))
    if (current === generation) overrides.value = [...overrides.value, value]
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : judgmentText('settings.saveError')
  } finally {
    if (current === generation) adding.value = false
  }
}

// A project that uses the default again leaves the list.
function changed(value: JudgmentPolicy) {
  overrides.value = value.inherited
    ? overrides.value.filter(policy => policy.personalProjectId !== value.personalProjectId)
    : overrides.value.map(policy => policy.personalProjectId === value.personalProjectId ? value : policy)
}
</script>

<template>
  <details class="judgment-overrides" data-judgment-overrides>
    <summary>
      {{ judgmentText('overrides.title') }}
      <span v-if="!loading && !error" class="judgment-overrides-count">{{ t('judgment.overrides.count', { count: overrides.length }) }}</span>
    </summary>
    <div class="judgment-overrides-body">
      <GrowthLoading v-if="loading" variant="compact" :label="judgmentText('overrides.loading')" />
      <template v-else-if="defaultPolicy">
        <p class="judgment-overrides-default" data-judgment-default>{{ t('judgment.overrides.default', { policy: policySummary(defaultPolicy) }) }}</p>
        <ProjectJudgmentPolicy v-for="policy in overrides" :key="policy.personalProjectId ?? ''" class="judgment-override"
          :personal-space-id="personalSpaceId" :project-id="policy.personalProjectId ?? ''" :project-name="projectName(policy.personalProjectId ?? '')"
          :heading="projectName(policy.personalProjectId ?? '')" :policy="policy" @change="changed" />
        <div v-if="addable.length" class="judgment-overrides-add">
          <label class="ui-sr-only" for="judgment-override-project">{{ judgmentText('overrides.project') }}</label>
          <select id="judgment-override-project" v-model="chosenProjectId" data-select="judgment-override-project" :disabled="adding">
            <option v-for="project in addable" :key="project.project_id" :value="project.project_id">{{ projectDisplayName(project) }}</option>
          </select>
          <Button size="sm" variant="outline" data-action="add-project-policy" :disabled="!chosenProjectId" :loading="adding" :loading-label="addingLabel" @click="add">
            {{ judgmentText('overrides.add') }}
          </Button>
        </div>
      </template>
      <div v-if="error" class="judgment-overrides-error" role="alert">
        <span>{{ error }}</span>
        <Button size="sm" variant="ghost" :disabled="loading" @click="load">{{ judgmentText('settings.retry') }}</Button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.judgment-overrides { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--card); }
.judgment-overrides summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; color: var(--color-ink); font-size: 13px; cursor: pointer; }
.judgment-overrides-count { color: var(--color-muted); font-size: 12px; }
.judgment-overrides-body { display: grid; gap: 14px; padding: 4px 14px 14px; }
.judgment-overrides-default { margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.judgment-override { padding-top: 12px; border-top: 1px solid var(--color-border); }
.judgment-overrides-add { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.judgment-overrides-add select { flex: 0 1 280px; min-width: 0; min-height: var(--control-height); padding: 6px 10px; border: 1px solid var(--color-control-border); border-radius: var(--radius-control); color: var(--color-ink); background: var(--color-surface); font: inherit; font-size: 13px; }
.judgment-overrides-error { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-danger-soft); font-size: 13px; }
</style>
