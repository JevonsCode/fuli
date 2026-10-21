<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { pickerOrder, projectDisplayName, isFormalProject } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiToggle from '@/ui/UiToggle.vue'
import type { CapturePolicyChange } from '@/types'
import {
  changedProjectSwitches, failedSaveMessage, PROJECT_MODES, projectMode, projectOffSinceDay, projectRecorded,
  recordsUnregisteredDirectories, type ProjectMode,
} from './project-capture'

// The settings page's project layer (rec#5 C4-1): which projects are recorded,
// several at once, and what happens to folders outside every project. The mode
// and the folder switch save at once; checked projects save together. Every
// change goes through the same saved settings the project page switch uses.
const store = useConsoleStore()
const policy = computed(() => store.state?.capturePolicy)
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => pickerOrder((store.state?.personalProjects ?? [])
  .filter(project => project.personal_space_id === spaceId.value && isFormalProject(project)))
  .map(project => ({ id: project.project_id, name: projectDisplayName(project) })))

type Pending = { kind: 'mode'; mode: ProjectMode } | { kind: 'unregistered'; record: boolean } | { kind: 'projects'; count: number }
const pending = ref<Pending | null>(null)
const message = ref<{ tone: 'error' | 'status'; text: string } | null>(null)
const loadFailure = ref('')

const offSince = computed(() => Object.fromEntries(projects.value.map(project => [project.id,
  projectOffSinceDay(policy.value, project.id) ?? ''])))
const mode = computed(() => pending.value?.kind === 'mode' ? pending.value.mode : projectMode(policy.value))
const recordsUnregistered = computed(() => pending.value?.kind === 'unregistered' ? pending.value.record
  : recordsUnregisteredDirectories(policy.value))

// Only the projects the person ticked here are theirs to save; every other
// project shows, and keeps, whatever the saved settings say now, so a switch
// made elsewhere meanwhile (the project page, an Agent's confirmed request)
// is never sent back (dot review P2-1, PR 262).
const touched = ref<Record<string, boolean>>({})
const chosen = computed(() => Object.fromEntries(projects.value.map(project => [project.id,
  touched.value[project.id] ?? projectRecorded(policy.value, project.id)])))
const changes = computed(() => changedProjectSwitches(policy.value, touched.value))
const changeCount = computed(() => Object.keys(changes.value).length)
const recordedCount = computed(() => projects.value.filter(project => chosen.value[project.id]).length)
function resetChoices() {
  touched.value = {}
}
function choose(next: Record<string, boolean>) {
  touched.value = { ...touched.value, ...next }
}

onMounted(async () => {
  try {
    await store.loadCapturePolicy()
    loadFailure.value = ''
  } catch (error) {
    loadFailure.value = t('capture.settings.loadFailed', { reason: apiErrorReason(error) })
  }
})

async function save(next: Pending, change: CapturePolicyChange, saved = '') {
  if (pending.value) return
  pending.value = next
  message.value = null
  try {
    await store.changeCapturePolicy(change)
    if (next.kind === 'projects') resetChoices()
    if (saved) message.value = { tone: 'status', text: saved }
  } catch (error) {
    message.value = { tone: 'error', text: await failedSaveMessage(error, () => store.settledCapturePolicy()) }
  } finally {
    pending.value = null
  }
}

function chooseMode(value: unknown) {
  const next = value as ProjectMode
  if (next !== projectMode(policy.value)) void save({ kind: 'mode', mode: next }, { projectMode: next })
}

function chooseAll(recorded: boolean) {
  choose(Object.fromEntries(projects.value.map(project => [project.id, recorded])))
}

const pendingLabel = computed(() => {
  const current = pending.value
  if (!current) return ''
  if (current.kind === 'mode') return t('capture.settings.changingMode', { mode: t(`capture.settings.modes.${current.mode}`) })
  if (current.kind === 'unregistered') return t('capture.settings.changingUnregistered')
  return t('capture.settings.saving', { count: current.count })
})
</script>

<template>
  <div class="capture-projects" data-capture-projects>
    <p v-if="loadFailure" class="capture-projects-error" role="alert">{{ loadFailure }}</p>

    <div class="capture-projects-mode">
      <span id="capture-projects-mode-label" class="capture-projects-label">{{ t('capture.settings.modeLabel') }}</span>
      <RadioGroup :model-value="mode" aria-labelledby="capture-projects-mode-label" class="grid gap-2"
        :disabled="pending !== null" @update:model-value="chooseMode">
        <label v-for="option in PROJECT_MODES" :key="option" class="capture-projects-option" :data-capture-mode="option">
          <RadioGroupItem :value="option" />
          <span><strong>{{ t(`capture.settings.modes.${option}`) }}</strong><small>{{ t(`capture.settings.modeHints.${option}`) }}</small></span>
        </label>
      </RadioGroup>
    </div>

    <label class="capture-projects-row" data-capture-unregistered>
      <span><strong>{{ t('capture.settings.unregistered') }}</strong><small>{{ t('capture.settings.unregisteredHint') }}</small></span>
      <UiToggle :model-value="recordsUnregistered" :label="t('capture.settings.unregistered')" :disabled="pending !== null"
        @update:model-value="value => save({ kind: 'unregistered', record: value }, { unregisteredDirectories: value ? 'capture' : 'skip' })" />
    </label>

    <div class="capture-projects-list-header">
      <span class="capture-projects-label">{{ t('capture.settings.projectsLabel') }}</span>
      <small v-if="projects.length" data-capture-projects-count>{{ t('capture.settings.projectsCount', { recorded: recordedCount, total: projects.length }) }}</small>
      <span class="capture-projects-bulk">
        <Button size="sm" variant="ghost" :disabled="pending !== null || !projects.length" data-capture-select-all @click="chooseAll(true)">{{ t('capture.settings.selectAll') }}</Button>
        <Button size="sm" variant="ghost" :disabled="pending !== null || !projects.length" data-capture-select-none @click="chooseAll(false)">{{ t('capture.settings.selectNone') }}</Button>
      </span>
    </div>
    <p v-if="!projects.length" class="capture-projects-message">{{ t('capture.settings.noProjects') }}</p>
    <ul v-else class="capture-projects-list">
      <li v-for="project in projects" :key="project.id" :data-capture-project="project.id">
        <label>
          <Checkbox :model-value="chosen[project.id]" :disabled="pending !== null"
            @update:model-value="value => choose({ [project.id]: value === true })" />
          <span class="capture-projects-name">{{ project.name }}</span>
          <small v-if="offSince[project.id]" class="capture-projects-since">
            {{ t('capture.settings.offSince', { day: offSince[project.id] }) }}
          </small>
        </label>
      </li>
    </ul>

    <div class="capture-projects-actions">
      <Button v-if="projects.length" size="sm" :disabled="!changeCount || (pending !== null && pending.kind !== 'projects')"
        :loading="pending?.kind === 'projects'" :loading-label="pendingLabel" data-capture-projects-save
        @click="save({ kind: 'projects', count: changeCount }, { recordProjects: changes }, t('capture.settings.saved'))">
        {{ t('capture.settings.save') }}
      </Button>
      <GrowthLoading v-if="pending && pending.kind !== 'projects'" variant="inline" :label="pendingLabel" data-capture-pending />
      <p v-else-if="message" :role="message.tone === 'error' ? 'alert' : 'status'" class="capture-projects-message"
        :class="{ 'capture-projects-error': message.tone === 'error' }" data-capture-message>{{ message.text }}</p>
    </div>
  </div>
</template>

<style scoped>
.capture-projects { display: grid; gap: 16px; min-width: 0; }
.capture-projects-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-block: 12px;
  border-block: 1px solid var(--color-border); cursor: pointer; }
.capture-projects-row > span { display: grid; gap: 4px; min-width: 0; }
.capture-projects-row strong { font-size: 14px; font-weight: 500; }
.capture-projects-row small { color: var(--color-muted); font-size: 12px; }
.capture-projects-label { font-size: 13px; font-weight: 550; }
.capture-projects-mode { display: grid; gap: 8px; }
.capture-projects-option { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.capture-projects-option > span { display: grid; gap: 2px; min-width: 0; }
.capture-projects-option strong { font-size: 14px; font-weight: 500; }
.capture-projects-option small, .capture-projects-list-header small, .capture-projects-since { color: var(--color-muted); font-size: 12px; }
.capture-projects-list-header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.capture-projects-bulk { display: inline-flex; gap: 4px; margin-left: auto; }
.capture-projects-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 16px; margin: 0; padding: 0; list-style: none; }
.capture-projects-list label { display: flex; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; min-width: 0; }
.capture-projects-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.capture-projects-since { flex: 0 0 auto; }
.capture-projects-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-height: 32px; }
.capture-projects-message { margin: 0; font-size: 13px; color: var(--color-muted); }
.capture-projects-error { margin: 0; font-size: 13px; color: var(--color-danger); }
</style>
