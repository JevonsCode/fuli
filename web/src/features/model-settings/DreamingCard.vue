<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import { readDreaming, startDreaming, type DreamingRun } from './dreaming'

// Dreaming needs a connected model, so without one this says only that. Its
// proposals wait in the review queue; here is whether it ran and what it found.
const props = defineProps<{ projects: readonly PersonalProject[] }>()

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
  <Card as="section" class="dreaming-card" data-dreaming>
    <div class="dreaming-head">
      <div>
        <h2>Dreaming</h2>
        <p>{{ t('modelSettings.dreaming.summary') }}</p>
      </div>
      <div v-if="readiness !== 'needs_model'" class="dreaming-actions">
        <OptionCombobox v-model="projectId" :options="choices" :label="t('modelSettings.dreaming.project')" data-dreaming-project />
        <Button size="sm" :disabled="readiness !== 'ready'" :loading="running"
          :loading-label="t('modelSettings.dreaming.running', { name: projectName(projectId) })" data-dreaming-run @click="run">
          {{ t('modelSettings.dreaming.run') }}
        </Button>
      </div>
    </div>
    <GrowthLoading v-if="readiness === null && projectId" variant="compact" :label="t('modelSettings.dreaming.loading')" />
    <p v-else-if="readiness === 'needs_model'" class="dreaming-note" data-dreaming-needs-model>{{ t('modelSettings.dreaming.needsModel') }}</p>
    <p v-else-if="readiness === 'project_not_approved'" class="dreaming-note">{{ t('modelSettings.dreaming.notApproved') }}</p>
    <p v-else-if="readiness === 'unavailable'" class="dreaming-note">{{ t('modelSettings.dreaming.unavailable') }}</p>
    <p v-if="error" role="alert" class="dreaming-error">{{ error }}</p>
    <ul v-if="runs.length" class="dreaming-runs">
      <li v-for="row in runs.slice(0, 5)" :key="row.at">
        <strong>{{ projectName(row.personalProjectId) }}</strong>
        <span>{{ t('modelSettings.dreaming.found', { sessions: row.sessions ?? 0, count: row.proposed?.length ?? 0 }) }}</span>
      </li>
    </ul>
  </Card>
</template>

<style scoped>
.dreaming-card { display: grid; gap: 12px; padding: 16px 24px; }
.dreaming-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.dreaming-head h2 { margin: 0; font-size: var(--text-section); font-weight: var(--weight-semibold, 600); }
.dreaming-head p, .dreaming-note { margin: 0; color: var(--color-muted); font-size: 13px; }
.dreaming-actions { display: flex; align-items: center; gap: 8px; min-width: min(100%, 320px); }
.dreaming-actions > :first-child { flex: 1; min-width: 0; }
.dreaming-error { margin: 0; color: var(--color-danger); font-size: 13px; }
.dreaming-runs { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 13px; }
.dreaming-runs li { display: flex; justify-content: space-between; gap: 12px; }
.dreaming-runs span { color: var(--color-muted); }
</style>
