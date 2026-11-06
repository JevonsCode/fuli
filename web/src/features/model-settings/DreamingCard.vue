<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import ModelUseCard from './ModelUseCard.vue'
import { readDreaming, startDreaming, type DreamingRun } from './dreaming'
import type { ModelRoleView } from './model'
import { stateTone, useAdvice } from './model-uses'

// Dreaming, one of Astro's tasks, as a use card: it runs on Astro's model, so
// without one its action opens Astro's settings. Its proposals wait in the
// review queue; here is whether it ran and what it found.
const props = withDefaults(defineProps<{ projects: readonly PersonalProject[]; status?: ModelRoleView['state']; model?: string | null }>(),
  { status: 'not_configured', model: null })
const emit = defineEmits<{ edit: [] }>()

const projectId = ref('')
const readiness = ref<string | null>(null)
const runs = ref<DreamingRun[]>([])
const running = ref(false)
const error = ref('')
const choices = computed(() => props.projects.filter(project => project.scope_type !== 'temporary')
  .map(project => ({ value: project.project_id, label: project.profile.name })))
const projectName = (id?: string | null) => choices.value.find(choice => choice.value === id)?.label ?? id ?? ''

watch(choices, (next) => { if (!projectId.value && next[0]) projectId.value = next[0].value }, { immediate: true })
watch(projectId, () => void load(), { immediate: true })

async function load() {
  if (!projectId.value) return
  const state = await readDreaming(projectId.value).catch(() => null)
  readiness.value = state?.readiness ?? 'unavailable'
  if (!state) return
  runs.value = state.runs ?? []
}

async function run() {
  running.value = true
  error.value = ''
  try {
    await startDreaming(projectId.value)
    await load()
  } catch (cause) {
    error.value = apiErrorReason(cause)
  } finally {
    running.value = false
  }
}
</script>

<template>
  <ModelUseCard name="Dreaming" :state="t(`modelSettings.uses.taskStates.${status}`)" :tone="stateTone(status)" :advice="useAdvice('dreaming')" data-dreaming>
    <template #model>
      <template v-if="model"><code>{{ model }}</code><span>{{ t('modelSettings.uses.astroModel') }}</span></template>
      <span v-else>{{ t('modelSettings.uses.astroNoModel') }}</span>
    </template>
    <GrowthLoading v-if="readiness === null && projectId" variant="compact" :label="t('modelSettings.dreaming.loading')" />
    <!-- Without Astro's model the model line already says so. -->
    <p v-else-if="readiness === 'needs_model' && model" class="dreaming-note" data-dreaming-needs-model>{{ t('modelSettings.dreaming.needsModel') }}</p>
    <p v-else-if="readiness === 'project_not_approved'" class="dreaming-note">{{ t('modelSettings.dreaming.notApproved') }}</p>
    <p v-else-if="readiness === 'unavailable'" class="dreaming-note">{{ t('modelSettings.dreaming.unavailable') }}</p>
    <p v-if="error" role="alert" class="dreaming-error">{{ error }}</p>
    <ul v-if="runs.length" class="dreaming-runs">
      <li v-for="row in runs.slice(0, 3)" :key="row.at">
        <strong>{{ projectName(row.personalProjectId) }}</strong>
        <span>{{ t('modelSettings.dreaming.found', { sessions: row.sessions ?? 0, count: row.proposed?.length ?? 0 }) }}</span>
      </li>
    </ul>
    <template #actions>
      <Button v-if="readiness === 'needs_model'" size="sm" variant="outline" data-dreaming-open @click="emit('edit')">{{ t('modelSettings.uses.openAstro') }}</Button>
      <template v-else>
        <OptionCombobox v-model="projectId" class="dreaming-project" size="sm" :options="choices" :label="t('modelSettings.dreaming.project')" data-dreaming-project />
        <Button size="sm" :disabled="readiness !== 'ready'" :loading="running"
          :loading-label="t('modelSettings.dreaming.running', { name: projectName(projectId) })" data-dreaming-run @click="run">
          {{ t('modelSettings.dreaming.run') }}
        </Button>
      </template>
    </template>
  </ModelUseCard>
</template>

<style scoped>
.dreaming-note { margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.dreaming-error { margin: 0; color: var(--color-danger); font-size: var(--text-control); }
.dreaming-runs { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: var(--text-control); }
.dreaming-runs li { display: flex; justify-content: space-between; gap: 12px; min-width: 0; }
.dreaming-runs strong { min-width: 0; overflow: hidden; font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.dreaming-runs span { flex: none; color: var(--color-muted); }
.dreaming-project { flex: 1; min-width: 0; }
</style>
