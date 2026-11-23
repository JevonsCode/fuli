<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { OptionSelect } from '@/components/ui/select'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { UiChip, UiIconButton, UiNotice } from '@/ui'
import {
  editWorkstreamTerms,
  endWorkstream,
  mergeWorkstream,
  moveWorkstream,
  openWorkstream,
  readProjectTeam,
  readProjectWorkstreams,
  splitWorkstream,
  type ProjectTeam,
  type ProjectWorkstream,
} from './project-team-api'

// The lead's ledger on the project page (docs/workstreams.md): which lines of
// work this project is divided into, who does each and how far it got, and
// the person's changes to it, each one click and one change: the owner, a
// merge, a split, an end. Nothing earlier is split retroactively.

const props = defineProps<{ spaceId: string; projectId: string }>()

type Problem = { code: string; line?: { assignmentId: string; name: string; revision: number }; terms?: string[] }
type Draft = { from: ProjectWorkstream | null; name: string; picked: string[]; words: string; ownerAgentId: string }

const team = ref<ProjectTeam | null>(null)
const lines = ref<ProjectWorkstream[]>([])
const loading = ref(false)
const failed = ref<'local_only' | 'failed' | null>(null)
const busy = ref('')
const problem = ref<Problem | null>(null)
const draft = ref<Draft | null>(null)
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !team.value))
let sequence = 0

// Anyone working on the project except its lead: a line exists to keep work off the lead's desk.
const candidates = computed(() => {
  const value = team.value
  if (!value) return []
  return [...(value.members ?? []), ...(value.collaborators ?? [])]
    .filter(person => person.agentId !== value.lead?.agentId && !person.peerRole)
    .map(person => ({ value: person.agentId, label: person.name }))
})
const ownerOptions = (line: ProjectWorkstream) => line.ownerOnProject ? candidates.value
  : [{ value: line.ownerAgentId, label: t('projects.workstreams.ownerGone', { name: line.ownerName ?? line.ownerAgentId }) },
    ...candidates.value]
const mergeOptions = (line: ProjectWorkstream) => lines.value.filter(item => item.assignmentId !== line.assignmentId)
  .map(item => ({ value: item.assignmentId, label: item.name }))
const words = (value: string) => [...new Set(value.split(/[,，;；\s]+/u).map(term => term.trim()).filter(Boolean))]
const canSubmit = computed(() => Boolean(draft.value && draft.value.name.trim() && draft.value.ownerAgentId
  && (draft.value.picked.length || words(draft.value.words).length)))

watch(() => [props.spaceId, props.projectId], () => {
  team.value = null
  lines.value = []
  draft.value = null
  problem.value = null
  void load()
}, { immediate: true })

async function load() {
  if (!props.spaceId || !props.projectId) return
  const current = ++sequence
  loading.value = true
  failed.value = null
  try {
    const [people, ledger] = await Promise.all([readProjectTeam(props.spaceId, props.projectId),
      readProjectWorkstreams(props.projectId)])
    if (current !== sequence) return
    team.value = people
    // An answer without lines (an older server) shows none rather than failing the page.
    lines.value = Array.isArray(ledger?.workstreams) ? ledger.workstreams : []
  } catch (error) {
    if (current === sequence) failed.value = codeOf(error) === 'local_user_only' ? 'local_only' : 'failed'
  } finally {
    if (current === sequence) loading.value = false
  }
}

function codeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  try { return JSON.parse(error.detail)?.code ?? null } catch { return null }
}

// Every change reads the ledger again, so the next one uses the revision the
// page shows. A refused change leaves the list as it was and says, in plain
// words, why and what to do next.
async function change(key: string, work: () => Promise<unknown>, context: Partial<Problem> = {}) {
  if (busy.value) return
  busy.value = key
  problem.value = null
  try {
    await work()
    draft.value = null
  } catch (error) {
    let detail: Partial<Problem> = {}
    try { detail = error instanceof ApiError ? JSON.parse(error.detail) : {} } catch { /* no detail */ }
    problem.value = { code: codeOf(error) ?? 'failed', ...context, ...(detail.line ? { line: detail.line } : {}) }
  } finally {
    busy.value = ''
    await load()
  }
}

function setOwner(line: ProjectWorkstream, leadAgentId: string) {
  if (!leadAgentId || leadAgentId === line.ownerAgentId) return
  void change(line.assignmentId, () => moveWorkstream(line.assignmentId,
    { expectedRevision: line.revision, projectId: props.projectId, leadAgentId }))
}

function mergeInto(line: ProjectWorkstream, targetId: string) {
  const target = lines.value.find(item => item.assignmentId === targetId)
  if (!target) return
  void change(line.assignmentId, () => mergeWorkstream(line.assignmentId,
    { into: target.assignmentId, expectedRevision: line.revision, targetRevision: target.revision }))
}

function end(line: ProjectWorkstream) {
  void change(line.assignmentId, () => endWorkstream(line.assignmentId, line.revision))
}

function startDraft(from: ProjectWorkstream | null) {
  problem.value = null
  draft.value = { from, name: '', picked: [], words: '', ownerAgentId: '' }
}

function togglePicked(term: string) {
  if (!draft.value) return
  const picked = draft.value.picked
  draft.value.picked = picked.includes(term) ? picked.filter(item => item !== term) : [...picked, term]
}

function submit() {
  const value = draft.value
  if (!value || !canSubmit.value) return
  const extra = words(value.words)
  const terms = [...value.picked, ...extra]
  void change('draft', () => value.from && value.picked.length
    ? splitWorkstream(value.from.assignmentId, { expectedRevision: value.from.revision, terms: value.picked,
      extraTerms: extra, leadAgentId: value.ownerAgentId, responsibility: value.name.trim() })
    : openWorkstream(props.projectId, { leadAgentId: value.ownerAgentId, terms, responsibility: value.name.trim() }),
  { terms })
}

// The refused new line's words go to the owner's existing line instead, in one click.
function addToExistingLine() {
  const target = problem.value?.line
  const terms = problem.value?.terms ?? []
  if (!target || !terms.length) return
  void change('add', () => editWorkstreamTerms(target.assignmentId,
    { expectedRevision: target.revision, addTerms: terms }))
}

function progress(line: ProjectWorkstream) {
  if (line.progressUnreadable) return t('projects.workstreams.progressUnreadable')
  if (!line.latestTask) return t('projects.workstreams.noTask')
  return t('projects.workstreams.latestTask', {
    status: taskStatusLabel(line.latestTask.status ?? '', { unrecognized: t('projects.workstreams.unknownStatus') }),
    title: line.latestTask.summary ?? '',
    date: formatDateTime(line.latestTask.at, currentLocale(), DATE_ONLY, { missing: '' }),
  })
}

const problemText = computed(() => {
  const value = problem.value
  if (!value) return ''
  const known = ['workstream_owner_has_line', 'standing_assignment_term_taken', 'standing_assignment_term_too_broad',
    'standing_assignment_changed', 'workstream_owner_is_lead', 'standing_assignment_user_confirmed',
    'workstream_owner_not_in_project']
  return known.includes(value.code)
    ? t(`projects.workstreams.problems.${value.code}`, { line: value.line?.name ?? '' })
    : t('projects.workstreams.problems.failed')
})
</script>

<template>
  <section v-if="lines.length || candidates.length || failed" class="project-workstreams"
    aria-labelledby="project-workstreams-heading">
    <header class="project-workstreams-header">
      <h3 id="project-workstreams-heading">{{ t('projects.workstreams.title') }}</h3>
      <span class="ui-meta">{{ t('projects.workstreams.hint') }}</span>
    </header>

    <GrowthLoading v-if="showLoading" variant="compact" :label="t('projects.workstreams.loading')" />
    <UiNotice v-else-if="failed === 'local_only'" tone="info" data-workstreams-local-only>
      {{ t('projects.workstreams.localOnly') }}
    </UiNotice>
    <UiNotice v-else-if="failed && !team" tone="error">
      {{ t('projects.workstreams.failed') }}
      <template #actions><Button size="sm" variant="ghost" @click="load">{{ t('projects.overview.retry') }}</Button></template>
    </UiNotice>

    <template v-else>
      <UiNotice v-if="problem" tone="warning" data-workstreams-problem>
        {{ problemText }}
        <template v-if="problem.code === 'workstream_owner_has_line'" #actions>
          <Button size="sm" variant="outline" data-add-to-line @click="addToExistingLine">
            {{ t('projects.workstreams.addToLine', { line: problem.line?.name ?? '' }) }}
          </Button>
          <Button size="sm" variant="ghost" @click="problem = null">{{ t('projects.workstreams.pickAnother') }}</Button>
          <Button size="sm" variant="ghost" as-child>
            <RouterLink :to="{ path: '/project-agents/manage', query: { project: projectId } }">
              {{ t('projects.workstreams.recruit') }}
            </RouterLink>
          </Button>
        </template>
      </UiNotice>

      <p v-if="!lines.length" class="ui-meta" data-workstreams-empty>{{ t('projects.workstreams.none') }}</p>
      <ul v-else class="project-workstreams-list">
        <li v-for="line in lines" :key="line.assignmentId" class="project-workstreams-item"
          :data-workstream="line.assignmentId">
          <div class="project-workstreams-main">
            <strong class="project-workstreams-name">{{ line.name }}</strong>
            <OptionSelect class="project-workstreams-owner" size="sm" :model-value="line.ownerAgentId"
              :options="ownerOptions(line)" :disabled="Boolean(busy)"
              :label="t('projects.workstreams.owner', { name: line.name })"
              @update:model-value="setOwner(line, $event)" />
            <span class="project-workstreams-terms">
              <UiChip v-for="term in line.terms" :key="term">{{ term }}</UiChip>
            </span>
          </div>
          <div class="project-workstreams-side">
            <span class="ui-meta" data-workstream-progress>
              {{ progress(line) }} ·
              {{ t(line.decidedBy === 'user' ? 'projects.workstreams.byYou' : 'projects.workstreams.byLead') }}
            </span>
            <OptionSelect v-if="lines.length > 1" class="project-workstreams-merge" size="sm" model-value=""
              :options="mergeOptions(line)" :disabled="Boolean(busy)"
              :placeholder="t('projects.workstreams.mergeInto')"
              :label="t('projects.workstreams.merge', { name: line.name })"
              @update:model-value="mergeInto(line, $event)" />
            <Button v-if="line.terms.length > 1" size="sm" variant="ghost" :disabled="Boolean(busy)"
              data-split-workstream @click="startDraft(line)">{{ t('projects.workstreams.split') }}</Button>
            <UiIconButton icon="close" size="sm" :disabled="Boolean(busy)"
              :label="t('projects.workstreams.end', { name: line.name })" @click="end(line)" />
          </div>
        </li>
      </ul>

      <Button v-if="!draft && candidates.length" size="sm" variant="ghost" data-open-workstream
        @click="startDraft(null)">{{ t('projects.workstreams.open') }}</Button>
      <form v-else-if="draft" class="project-workstreams-form" @submit.prevent="submit">
        <p v-if="draft.from" class="ui-meta">{{ t('projects.workstreams.splitFrom', { line: draft.from.name }) }}</p>
        <div v-if="draft.from" class="project-workstreams-chips">
          <Button v-for="term in draft.from.terms" :key="term" type="button" size="xs"
            :variant="draft.picked.includes(term) ? 'secondary' : 'outline'"
            :aria-pressed="draft.picked.includes(term)" :data-term-chip="term" @click="togglePicked(term)">
            {{ term }}
          </Button>
        </div>
        <Input v-model="draft.name" size="sm" maxlength="240" :aria-label="t('projects.workstreams.nameLabel')"
          :placeholder="t('projects.workstreams.nameLabel')" data-workstream-name />
        <Input v-model="draft.words" size="sm" :aria-label="t('projects.workstreams.termsLabel')"
          :placeholder="t('projects.workstreams.termsLabel')" data-workstream-words />
        <OptionSelect v-model="draft.ownerAgentId" size="sm" :options="candidates"
          :label="t('projects.workstreams.ownerLabel')" :placeholder="t('projects.workstreams.ownerLabel')" />
        <Button type="submit" size="sm" :disabled="!canSubmit || Boolean(busy)">{{ t('projects.workstreams.confirm') }}</Button>
        <Button type="button" size="sm" variant="ghost" @click="draft = null">{{ t('projects.workstreams.cancel') }}</Button>
      </form>
    </template>
  </section>
</template>

<style scoped>
.project-workstreams-header {
  align-items: baseline;
  display: flex;
  gap: 0.75rem;
  justify-content: space-between;
}

.project-workstreams-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  list-style: none;
  margin: 0.5rem 0;
  padding: 0;
}

.project-workstreams-item {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  justify-content: space-between;
}

.project-workstreams-main,
.project-workstreams-side,
.project-workstreams-terms,
.project-workstreams-chips,
.project-workstreams-form {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.project-workstreams-owner,
.project-workstreams-merge {
  width: 12rem;
}

.project-workstreams-form > p {
  flex-basis: 100%;
  margin: 0;
}
</style>
