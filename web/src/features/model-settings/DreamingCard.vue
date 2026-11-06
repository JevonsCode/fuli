<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import UiNotice from '@/ui/UiNotice.vue'
import ModelUseCard from './ModelUseCard.vue'
import { readDreaming, startDreaming, type DreamingProject, type DreamingResult } from './dreaming'
import type { ModelRoleView } from './model'
import { stateTone, useAdvice } from './model-uses'

// Dreaming, one of Astro's tasks, as a use card (11-06). Projects with new
// sessions come first, each with 「整理」; the rest wait in a short quiet list
// whose 「整理一次」 reads every session again. A project that just ran keeps
// its place and says what it found, with a link to the review queue. Without
// Astro's model the action opens Astro's settings.
const QUIET_SHOWN = 3
const props = withDefaults(defineProps<{ status?: ModelRoleView['state']; model?: string | null }>(),
  { status: 'not_configured', model: null })
const emit = defineEmits<{ edit: [] }>()

type Group = 'fresh' | 'quiet'
const readiness = ref<string | null>(null)
const projects = ref<DreamingProject[]>([])
const running = ref<{ id: string; fromStart: boolean } | null>(null)
const results = ref<Record<string, DreamingResult>>({})
// Where a run started, so its row does not jump lists when its count drops to 0.
const placed = ref<Record<string, Group>>({})
const showAll = ref(false)
const error = ref('')

const ready = computed(() => projects.value.filter(project => project.readiness === 'ready'))
const groupOf = (project: DreamingProject): Group => placed.value[project.personalProjectId] ?? ((project.newSessions ?? 0) > 0 ? 'fresh' : 'quiet')
const fresh = computed(() => ready.value.filter(project => groupOf(project) === 'fresh'))
const quiet = computed(() => ready.value.filter(project => groupOf(project) === 'quiet'))
const quietShown = computed(() => (showAll.value ? quiet.value : quiet.value.slice(0, QUIET_SHOWN)))
const unapproved = computed(() => projects.value.filter(project => project.readiness === 'project_not_approved'))

onMounted(() => void load())

async function load() {
  const state = await readDreaming().catch(() => null)
  readiness.value = state?.readiness ?? 'unavailable'
  if (state) projects.value = state.projects
}

async function run(project: DreamingProject, fromStart: boolean) {
  const id = project.personalProjectId
  placed.value = { ...placed.value, [id]: groupOf(project) }
  running.value = { id, fromStart }
  error.value = ''
  try {
    results.value = { ...results.value, [id]: await startDreaming(id, fromStart) }
    await load()
  } catch (cause) {
    error.value = apiErrorReason(cause)
  } finally {
    running.value = null
  }
}

const lastRun = (project: DreamingProject) => {
  const when = project.lastRun && formatRelativeTime(project.lastRun.at, currentLocale())
  return when ? t('modelSettings.dreaming.lastRun', { when }) : t('modelSettings.dreaming.neverRun')
}
const queued = (result?: DreamingResult) => result?.proposed?.filter(proposal => proposal.status === 'queued').length ?? 0

function resultLine(result: DreamingResult) {
  if (result.status === 'dreamed') return t('modelSettings.dreaming.found', { sessions: result.sessions ?? 0, count: queued(result) })
  if (result.status === 'nothing_to_read') return t('modelSettings.dreaming.nothingNew')
  return t('modelSettings.dreaming.notFinished')
}

function meta(project: DreamingProject) {
  const result = results.value[project.personalProjectId]
  if (result) return resultLine(result)
  if ((project.newSessions ?? 0) > 0) return t('modelSettings.dreaming.newSessions', { count: project.newSessions ?? 0, last: lastRun(project) })
  if (!project.lastRun) return t('modelSettings.dreaming.noSessions')
  return t('modelSettings.dreaming.noNewSessions', { last: lastRun(project) })
}

// A full re-read is offered once the project has something it could read again.
const canRun = (project: DreamingProject, group: Group) => group === 'fresh' || project.lastRun !== null
const runLabel = (project: DreamingProject) => t(running.value?.fromStart ? 'modelSettings.dreaming.rereading' : 'modelSettings.dreaming.running',
  { name: project.name })
</script>

<template>
  <ModelUseCard name="Dreaming" :state="t(`modelSettings.uses.taskStates.${status}`)" :tone="stateTone(status)" :advice="useAdvice('dreaming')" data-dreaming>
    <template #model>
      <template v-if="model"><code>{{ model }}</code><span>{{ t('modelSettings.uses.astroModel') }}</span></template>
      <span v-else>{{ t('modelSettings.uses.astroNoModel') }}</span>
    </template>
    <GrowthLoading v-if="readiness === null" variant="compact" :label="t('modelSettings.dreaming.loading')" />
    <!-- Without Astro's model the model line already says so. -->
    <p v-else-if="readiness === 'needs_model'" v-show="model" class="dreaming-note" data-dreaming-needs-model>{{ t('modelSettings.dreaming.needsModel') }}</p>
    <p v-else-if="readiness === 'unavailable'" class="dreaming-note">{{ t('modelSettings.dreaming.unavailable') }}</p>
    <template v-else>
      <p v-if="ready.length" class="dreaming-note" data-dreaming-daily>{{ t('modelSettings.dreaming.daily') }}</p>
      <template v-for="[group, rows] in ([['fresh', fresh], ['quiet', quietShown]] as const)" :key="group">
        <ul v-if="rows.length" class="dreaming-list" :class="`dreaming-list--${group}`" :data-dreaming-list="group">
          <li v-for="project in rows" :key="project.personalProjectId" class="dreaming-row" :data-dreaming-row="project.personalProjectId">
            <span class="dreaming-name" :title="project.name">{{ project.name }}</span>
            <span class="dreaming-meta" data-dreaming-meta>{{ meta(project) }}</span>
            <RouterLink v-if="queued(results[project.personalProjectId]) > 0" to="/inbox" class="dreaming-confirm" data-dreaming-confirm>
              {{ t('modelSettings.dreaming.confirm') }}
            </RouterLink>
            <Button v-if="canRun(project, group)" size="sm" :variant="group === 'fresh' ? 'outline' : 'ghost'"
              :title="group === 'quiet' ? t('modelSettings.dreaming.runAgainHint') : undefined"
              :disabled="running !== null && running.id !== project.personalProjectId" :loading="running?.id === project.personalProjectId"
              :loading-label="runLabel(project)" data-dreaming-run @click="run(project, group === 'quiet')">
              {{ t(group === 'fresh' ? 'modelSettings.dreaming.run' : 'modelSettings.dreaming.runAgain') }}
            </Button>
          </li>
        </ul>
      </template>
      <Button v-if="quiet.length > QUIET_SHOWN" class="dreaming-more" size="sm" variant="link" data-dreaming-more @click="showAll = !showAll">
        {{ showAll ? t('modelSettings.dreaming.showLess') : t('modelSettings.dreaming.showAll', { count: quiet.length }) }}
      </Button>
      <p v-if="unapproved.length" class="dreaming-note" :title="unapproved.map(project => project.name).join('、')" data-dreaming-unapproved>
        {{ t('modelSettings.dreaming.notApproved', { count: unapproved.length }) }}
      </p>
    </template>
    <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
    <template #actions>
      <Button v-if="readiness === 'needs_model' || unapproved.length" size="sm" variant="outline" data-dreaming-open @click="emit('edit')">
        {{ t('modelSettings.uses.openAstro') }}
      </Button>
    </template>
  </ModelUseCard>
</template>

<style scoped>
.dreaming-note { margin: 0; color: var(--color-muted); font-size: var(--text-control); }
.dreaming-list { display: grid; margin: 0; padding: 0; list-style: none; font-size: var(--text-control); }
.dreaming-list--quiet { color: var(--color-muted); }
/* Every row is one control high, so rows with and without a button line up. */
.dreaming-row { display: flex; align-items: center; gap: var(--space-3); min-width: 0; min-height: var(--control-height-sm); }
.dreaming-name { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--color-ink); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.dreaming-list--quiet .dreaming-name { font-weight: var(--weight-regular); }
.dreaming-meta { flex: 1 1 auto; min-width: 0; overflow: hidden; color: var(--color-muted); text-overflow: ellipsis; white-space: nowrap; }
.dreaming-confirm { flex: none; color: var(--color-link); font-weight: var(--weight-medium); text-decoration: none; user-select: none; }
.dreaming-confirm:hover { text-decoration: underline; }
.dreaming-row :deep(button) { flex: none; margin-inline-start: auto; user-select: none; }
.dreaming-more { justify-self: start; padding-inline: 0; user-select: none; }
</style>
