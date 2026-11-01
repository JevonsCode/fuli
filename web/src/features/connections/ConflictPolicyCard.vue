<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { OptionCombobox } from '@/components/ui/combobox'
import type { SelectOption } from '@/components/ui/select'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import UiIcon from '@/ui/UiIcon.vue'
import UiIconButton from '@/ui/UiIconButton.vue'
import UiNotice from '@/ui/UiNotice.vue'
import UiSegmented from '@/ui/UiSegmented.vue'
import {
  CONFLICT_MODES, otherMode, projectExceptions, projectsFollowingDefault, readConflictPolicies,
  saveDefaultConflictMode, saveProjectConflictMode, withProjectChoice,
  type ConflictMode, type ConflictPolicyOverview,
} from './conflict-policy'
import { readmeHelpUrl } from './readme-help'

const store = useConsoleStore()
const overview = ref<ConflictPolicyOverview | null>(null)
const loading = ref(false)
const loadFailed = ref(false)
// The save in flight, as its loading label; one at a time.
const savingLabel = ref('')
const adding = ref(false)
const addProjectId = ref('')
const addMode = ref<ConflictMode>('agent_decide')
let controller: AbortController | null = null

const helpUrl = computed(() => readmeHelpUrl('external-knowledge-conflict-policy'))
const projects = computed(() => store.state?.personalProjects ?? [])
const exceptions = computed(() => overview.value ? projectExceptions(overview.value, projects.value) : [])
const addableOptions = computed<SelectOption[]>(() => overview.value
  ? projectsFollowingDefault(overview.value, projects.value).map((project) => ({
      value: project.project_id,
      label: project.profile.name,
      meta: `#${compactIdentity(project.project_id, 26)}`,
      search: identitySearchText(project.project_id),
    }))
  : [])
const modeOptions = computed(() => CONFLICT_MODES.map((mode) => ({
  value: mode, label: t(`pages.connections.conflictMode.${mode}`),
})))

onMounted(() => void load())
onBeforeUnmount(() => controller?.abort())

async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  loadFailed.value = false
  try {
    overview.value = await readConflictPolicies(current.signal)
  } catch {
    if (!current.signal.aborted) loadFailed.value = true
  } finally {
    if (controller === current) {
      loading.value = false
      controller = null
    }
  }
}

// Shows the requested choice at once and puts the confirmed one back if the save fails.
async function save(label: string, requested: ConflictPolicyOverview,
  request: (confirmed: ConflictPolicyOverview) => Promise<ConflictPolicyOverview>) {
  const confirmed = overview.value
  if (!confirmed || savingLabel.value) return false
  savingLabel.value = label
  overview.value = requested
  try {
    overview.value = await request(confirmed)
    store.notify(t('pages.connections.conflictSaved'))
    return true
  } catch (error) {
    overview.value = confirmed
    store.reportError(error)
    return false
  } finally {
    savingLabel.value = ''
  }
}

function saveDefault(mode: ConflictMode) {
  const current = overview.value
  if (!current || current.default.mode === mode) return
  void save(t('pages.connections.savingConflictDefault'), { ...current, default: { ...current.default, mode } },
    async (confirmed) => ({ ...confirmed, default: await saveDefaultConflictMode(mode) }))
}

function saveProject(projectId: string, name: string, mode: ConflictMode | null, label: string) {
  const current = overview.value
  const personalSpaceId = store.activePersonalSpace?.id
  if (!current || !personalSpaceId) return Promise.resolve(false)
  const requested = mode === null
    ? { ...current, projects: current.projects.filter(({ personalProjectId }) => personalProjectId !== projectId) }
    : withProjectChoice(current, { personalProjectId: projectId, mode, source: 'project' })
  return save(t(label, { name }), requested, async (confirmed) =>
    withProjectChoice(confirmed, await saveProjectConflictMode(personalSpaceId, projectId, mode)))
}

function startAdding() {
  if (!overview.value) return
  addProjectId.value = ''
  addMode.value = otherMode(overview.value.default.mode)
  adding.value = true
}

async function addException() {
  const project = projects.value.find(({ project_id }) => project_id === addProjectId.value)
  if (!project) return
  if (await saveProject(project.project_id, project.profile.name, addMode.value, 'pages.connections.savingConflictProject')) {
    adding.value = false
  }
}
</script>

<template>
  <Card as="section" class="conflict-policy-section" aria-labelledby="conflict-policy-title">
    <div class="flex flex-wrap items-center gap-2 px-5">
      <CardTitle id="conflict-policy-title" as="h2" class="text-base">{{ t('pages.connections.conflictTitle') }}</CardTitle>
      <a
        class="section-help-link"
        data-testid="conflict-policy-help"
        :href="helpUrl"
        :aria-label="t('pages.connections.conflictHelp')"
        :title="t('pages.connections.conflictHelp')"
        target="_blank"
        rel="noreferrer"
      >?</a>
      <Button
        class="conflict-policy-add-action ml-auto"
        size="sm"
        variant="ghost"
        :disabled="!overview || adding || !addableOptions.length"
        @click="startAdding"
      >
        <UiIcon name="plus" :size="16" />{{ t('pages.connections.conflictAddException') }}
      </Button>
    </div>
    <div class="grid gap-3 px-5">
      <GrowthLoading v-if="loading" variant="compact" :label="t('pages.connections.loadingConflictPolicies')" />
      <UiNotice v-else-if="loadFailed" tone="error">
        {{ t('common.errors.loadFailed') }}
        <template #actions>
          <Button variant="outline" size="sm" @click="load">{{ t('common.actions.retry') }}</Button>
        </template>
      </UiNotice>
      <ul v-if="overview" class="conflict-policy-list">
        <li class="conflict-policy-row" data-testid="conflict-policy-default">
          <strong>{{ t('pages.connections.conflictDefault') }}</strong>
          <UiSegmented
            :model-value="overview.default.mode"
            :label="t('pages.connections.conflictDefaultLabel')"
            :options="modeOptions"
            @update:model-value="saveDefault"
          />
        </li>
        <li
          v-for="exception in exceptions"
          :key="exception.id"
          class="conflict-policy-row"
          :data-project-id="exception.id"
        >
          <span class="conflict-policy-name">{{ exception.name }}</span>
          <UiSegmented
            :model-value="exception.mode"
            :label="t('pages.connections.conflictProjectLabel', { name: exception.name })"
            :options="modeOptions"
            @update:model-value="(mode: ConflictMode) => mode !== exception.mode
              && saveProject(exception.id, exception.name, mode, 'pages.connections.savingConflictProject')"
          />
          <UiIconButton
            icon="close"
            size="sm"
            :label="t('pages.connections.conflictUseDefault', { name: exception.name })"
            :disabled="Boolean(savingLabel)"
            @click="saveProject(exception.id, exception.name, null, 'pages.connections.clearingConflictProject')"
          />
        </li>
        <li v-if="adding" class="conflict-policy-row">
          <form class="conflict-policy-add" @submit.prevent="addException">
            <OptionCombobox
              v-model="addProjectId"
              control-id="conflict-exception-project"
              :label="t('pages.connections.conflictExceptionProject')"
              :placeholder="t('pages.connections.conflictExceptionProject')"
              :options="addableOptions"
              :disabled="Boolean(savingLabel)"
              required
            />
            <UiSegmented
              v-model="addMode"
              :label="t('pages.connections.conflictExceptionMode')"
              :options="modeOptions"
            />
            <div class="conflict-policy-add-actions">
              <Button type="button" size="sm" variant="ghost" @click="adding = false">{{ t('common.actions.cancel') }}</Button>
              <Button type="submit" size="sm" :disabled="!addProjectId || Boolean(savingLabel)">{{ t('pages.connections.conflictAdd') }}</Button>
            </div>
          </form>
        </li>
      </ul>
      <GrowthLoading v-if="savingLabel" variant="inline" :label="savingLabel" />
    </div>
  </Card>
</template>

<style scoped>
.conflict-policy-list { display: grid; grid-template-columns: minmax(0, 1fr) auto 32px; gap: 8px 12px; margin: 0; padding: 0; list-style: none; }
.conflict-policy-row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; }
.conflict-policy-row > strong, .conflict-policy-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conflict-policy-row > strong { font-weight: var(--weight-medium); }
/* The new exception lines up with the rows above; its actions sit under it, so nothing above moves. */
.conflict-policy-add { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; row-gap: 8px; align-items: center; }
.conflict-policy-add > :first-child { grid-column: 1; min-width: 0; }
.conflict-policy-add-actions { display: flex; grid-column: 1 / -1; gap: 4px; justify-self: end; }
@media (max-width: 720px) {
  .conflict-policy-list { grid-template-columns: minmax(0, 1fr) 32px; }
  .conflict-policy-row > .ui-segmented, .conflict-policy-add > .ui-segmented { grid-column: 1 / -1; grid-row: 2; justify-self: start; }
  .conflict-policy-add > :first-child { grid-column: 1 / -1; }
  .conflict-policy-add-actions { grid-row: 3; }
}
</style>
