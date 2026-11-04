<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import { pickerOrder, projectDisplayName } from '@/features/projects/project-origin'
import type { PersonalProject } from '@/types'

import ProjectJudgmentPolicy from './ProjectJudgmentPolicy.vue'
import { judgmentText } from './judgment-copy'
import { loadJudgmentPolicyOverrides, startProjectJudgmentPolicy } from './judgment-api'
import { normalizeJudgmentPolicy, type JudgmentPolicy } from './judgment-types'

// Tonborg's workbench: the projects that judge differently from Tonborg's
// default. Adding one starts it from the default; removing one (恢复默认)
// takes it off the list. The default itself is the card beside this one.
const props = withDefaults(defineProps<{ personalSpaceId: string; projects?: PersonalProject[] }>(), { projects: () => [] })

const overrides = ref<JudgmentPolicy[]>([])
const loading = ref(false)
const loaded = ref(false)
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
const addableOptions = computed(() => addable.value.map(project => ({ value: project.project_id, label: projectDisplayName(project) })))
const addingLabel = computed(() => t('judgment.project.starting', { name: projectName(chosenProjectId.value) }))

watch(() => props.personalSpaceId, () => { void load() }, { immediate: true })
watch(addable, projects => {
  if (!projects.some(project => project.project_id === chosenProjectId.value)) chosenProjectId.value = projects[0]?.project_id ?? ''
}, { immediate: true })

async function load() {
  const current = ++generation
  error.value = ''
  loaded.value = false
  overrides.value = []
  if (!props.personalSpaceId) return
  loading.value = true
  try {
    const value = await loadJudgmentPolicyOverrides(props.personalSpaceId)
    if (current !== generation) return
    overrides.value = (value.overrides ?? []).map(policy => normalizeJudgmentPolicy(policy))
    loaded.value = true
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
  <Card as="section" aria-labelledby="judgment-overrides-title" data-judgment-overrides>
    <CardHeader>
      <CardTitle id="judgment-overrides-title" as="h2">{{ judgmentText('overrides.title') }}</CardTitle>
      <CardAction v-if="loaded" class="judgment-overrides-count">{{ t('judgment.overrides.count', { count: overrides.length }) }}</CardAction>
    </CardHeader>
    <div class="judgment-overrides-body">
      <GrowthLoading v-if="loading" variant="compact" :label="judgmentText('overrides.loading')" />
      <template v-else-if="loaded">
        <ProjectJudgmentPolicy v-for="policy in overrides" :key="policy.personalProjectId ?? ''" class="judgment-override"
          :personal-space-id="personalSpaceId" :project-id="policy.personalProjectId ?? ''" :project-name="projectName(policy.personalProjectId ?? '')"
          :heading="projectName(policy.personalProjectId ?? '')" :policy="policy" @change="changed" />
        <div v-if="addable.length" class="judgment-overrides-add">
          <OptionCombobox v-model="chosenProjectId" class="judgment-overrides-project" control-id="judgment-override-project" data-select="judgment-override-project"
            :label="judgmentText('overrides.project')" :options="addableOptions" :disabled="adding" />
          <Button variant="outline" data-action="add-project-policy" :disabled="!chosenProjectId" :loading="adding" :loading-label="addingLabel" @click="add">
            {{ judgmentText('overrides.add') }}
          </Button>
        </div>
      </template>
      <div v-if="error" class="judgment-overrides-error" role="alert">
        <span>{{ error }}</span>
        <Button size="sm" variant="ghost" :disabled="loading" @click="load">{{ judgmentText('settings.retry') }}</Button>
      </div>
    </div>
  </Card>
</template>

<style scoped>
.judgment-overrides-count { color: var(--color-muted); font-size: 12px; }
.judgment-overrides-body { display: grid; gap: 14px; padding: 0 var(--space-5, 20px); }
.judgment-override + .judgment-override { padding-top: 12px; border-top: 1px solid var(--color-border); }
.judgment-overrides-add { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.judgment-override + .judgment-overrides-add { padding-top: 12px; border-top: 1px solid var(--color-border); }
.judgment-overrides-project { flex: 0 1 280px; }
.judgment-overrides-error { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 12px; border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-danger-soft); font-size: 13px; }
</style>
