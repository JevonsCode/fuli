<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
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
import { UiChip, UiDialog, UiIconButton, UiNotice } from '@/ui'
import {
  editWorkstreamTerms,
  endWorkstream,
  mergeWorkstream,
  moveWorkstream,
  openWorkstream,
  readProjectTeam,
  readProjectWorkstreams,
  splitWorkstream,
  type ClosedWorkstream,
  type ProjectTeam,
  type ProjectWorkstream,
} from './project-team-api'

// The lead's ledger on the project page (docs/workstreams.md): which lines of
// work this project is divided into, who does each and how far it got, and
// the person's changes to it, each one click and one change: the owner, a
// word less, a merge, a split, an end. A merge or an end is asked once first,
// saying what happens and how it is undone; ended lines stay listed, folded.
// Nothing earlier is split retroactively.

const props = defineProps<{ spaceId: string; projectId: string }>()

// again: the refused change once more, at the revision the page shows by then.
type Problem = { code: string; line?: { assignmentId: string; name: string; revision: number }; terms?: string[];
  again: () => void }
type Draft = { from: ProjectWorkstream | null; name: string; picked: string[]; words: string; ownerAgentId: string }
type Pending = { kind: 'merge'; line: ProjectWorkstream; into: ProjectWorkstream } | { kind: 'end'; line: ProjectWorkstream }

const team = ref<ProjectTeam | null>(null)
const lines = ref<ProjectWorkstream[]>([])
const closed = ref<ClosedWorkstream[]>([])
const pending = ref<Pending | null>(null)
const loading = ref(false)
const failed = ref<'local_only' | 'failed' | null>(null)
const busy = ref('')
const problem = ref<Problem | null>(null)
const draft = ref<Draft | null>(null)
const form = ref<HTMLFormElement | null>(null)
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
// Two Han, kana or Hangul characters (性能, 上线) also occur in requests about
// other things. The person may still use them; the form says so once.
const SHORT_UNSPACED = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]{2}$/u
const shortWords = computed(() => draft.value ? words(draft.value.words).filter(term => SHORT_UNSPACED.test(term)) : [])

watch(() => [props.spaceId, props.projectId], () => {
  team.value = null
  lines.value = []
  closed.value = []
  pending.value = null
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
    closed.value = Array.isArray(ledger?.closed) ? ledger.closed : []
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
// words, why and what to do next; `again` tries it once more from what was read.
async function change(key: string, work: () => Promise<unknown>, again: () => void,
  context: Partial<Problem> = {}) {
  if (busy.value) return
  busy.value = key
  problem.value = null
  try {
    await work()
    draft.value = null
  } catch (error) {
    let detail: Partial<Problem> = {}
    try { detail = error instanceof ApiError ? JSON.parse(error.detail) : {} } catch { /* no detail */ }
    problem.value = { code: codeOf(error) ?? 'failed', ...context, ...(detail.line ? { line: detail.line } : {}), again }
  } finally {
    await load()
    busy.value = ''
  }
}

// The line as the page read it last; a line gone since is not changed again.
const current = (line: ProjectWorkstream) => lines.value.find(item => item.assignmentId === line.assignmentId)
const onCurrent = (line: ProjectWorkstream, act: (fresh: ProjectWorkstream) => void) => () => {
  const fresh = current(line)
  if (fresh) act(fresh)
}

function setOwner(line: ProjectWorkstream, leadAgentId: string) {
  if (!leadAgentId || leadAgentId === line.ownerAgentId) return
  void change(line.assignmentId, () => moveWorkstream(line.assignmentId,
    { expectedRevision: line.revision, projectId: props.projectId, leadAgentId }),
  onCurrent(line, fresh => setOwner(fresh, leadAgentId)))
}

// A merge or an end changes where later tasks go; it is asked once first.
function mergeInto(line: ProjectWorkstream, targetId: string) {
  const into = lines.value.find(item => item.assignmentId === targetId)
  if (into) pending.value = { kind: 'merge', line, into }
}

function end(line: ProjectWorkstream) {
  pending.value = { kind: 'end', line }
}

function confirmPending() {
  const value = pending.value
  if (!value) return
  pending.value = null
  apply(value)
}

function apply(value: Pending) {
  const { line } = value
  void change(line.assignmentId, () => value.kind === 'merge'
    ? mergeWorkstream(line.assignmentId, { into: value.into.assignmentId, expectedRevision: line.revision,
      targetRevision: value.into.revision })
    : endWorkstream(line.assignmentId, line.revision),
  onCurrent(line, fresh => {
    if (value.kind === 'end') return apply({ kind: 'end', line: fresh })
    const into = current(value.into)
    if (into) apply({ kind: 'merge', line: fresh, into })
  }))
}

const pendingText = computed(() => {
  const value = pending.value
  if (!value) return { title: '', body: '', action: '' }
  if (value.kind === 'end') {
    return { title: t('projects.workstreams.endTitle', { name: value.line.name }),
      body: t('projects.workstreams.endEffect'), action: t('projects.workstreams.endAction') }
  }
  const owner = value.into.ownerName ?? value.into.ownerAgentId
  return { title: t('projects.workstreams.mergeTitle', { from: value.line.name, into: value.into.name }),
    body: t('projects.workstreams.mergeEffect', { from: value.line.name, into: value.into.name, owner }),
    action: t('projects.workstreams.mergeAction') }
})

// One word less: later tasks that say only it no longer come to this line.
function removeTerm(line: ProjectWorkstream, term: string) {
  void change(line.assignmentId, () => editWorkstreamTerms(line.assignmentId,
    { expectedRevision: line.revision, removeTerms: [term] }), onCurrent(line, fresh => removeTerm(fresh, term)))
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

// A refused draft stays open; sending it again splits the line as read since.
function submit() {
  const value = draft.value
  if (!value || !canSubmit.value) return
  const from = value.from ? current(value.from) ?? value.from : null
  const extra = words(value.words)
  const terms = [...value.picked, ...extra]
  void change('draft', () => from && value.picked.length
    ? splitWorkstream(from.assignmentId, { expectedRevision: from.revision, terms: value.picked,
      extraTerms: extra, leadAgentId: value.ownerAgentId, responsibility: value.name.trim() })
    : openWorkstream(props.projectId, { leadAgentId: value.ownerAgentId, terms, responsibility: value.name.trim() }),
  submit, { terms })
}

// The refused new line's words go to the owner's existing line instead, in one click.
function addToExistingLine() {
  const line = problem.value?.line
  const terms = problem.value?.terms ?? []
  if (!line || !terms.length) return
  const target = lines.value.find(item => item.assignmentId === line.assignmentId) ?? line
  void change('add', () => editWorkstreamTerms(target.assignmentId,
    { expectedRevision: target.revision, addTerms: terms }), addToExistingLine, { line: target, terms })
}

// A word refused as taken or too broad is changed in the draft's words.
async function changeWords() {
  problem.value = null
  if (!draft.value) startDraft(null)
  await nextTick()
  form.value?.querySelector<HTMLInputElement>('[data-workstream-words]')?.focus()
}

const TERM_PROBLEMS = ['standing_assignment_term_taken', 'standing_assignment_term_too_broad']

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
    <UiNotice v-else-if="failed === 'local_only'" tone="info" data-workstreams-local-only
      data-no-action="lines are read and changed only on the computer that runs FULI; nothing on this console opens them there">
      {{ t('projects.workstreams.localOnly') }}
    </UiNotice>
    <UiNotice v-else-if="failed && !team" tone="error">
      {{ t('projects.workstreams.failed') }}
      <template #actions><Button size="sm" variant="ghost" @click="load">{{ t('projects.overview.retry') }}</Button></template>
    </UiNotice>

    <template v-else>
      <UiNotice v-if="problem" tone="warning" data-workstreams-problem>
        {{ problemText }}
        <!-- One next step per reason: the words, the owner, the team, or the same change again. -->
        <template #actions>
          <template v-if="problem.code === 'workstream_owner_has_line'">
            <Button size="sm" variant="outline" :disabled="Boolean(busy)" data-add-to-line @click="addToExistingLine">
              {{ t('projects.workstreams.addToLine', { line: problem.line?.name ?? '' }) }}
            </Button>
            <Button size="sm" variant="ghost" @click="problem = null">{{ t('projects.workstreams.pickAnother') }}</Button>
            <Button size="sm" variant="ghost" as-child>
              <RouterLink :to="{ path: '/project-agents/manage', query: { project: projectId } }">
                {{ t('projects.workstreams.recruit') }}
              </RouterLink>
            </Button>
          </template>
          <Button v-else-if="TERM_PROBLEMS.includes(problem.code)" size="sm" variant="outline" data-change-words
            @click="changeWords">{{ t('projects.workstreams.changeWords') }}</Button>
          <Button v-else-if="problem.code === 'workstream_owner_is_lead'" size="sm" variant="outline"
            data-pick-another @click="problem = null">{{ t('projects.workstreams.pickAnother') }}</Button>
          <Button v-else-if="problem.code === 'workstream_owner_not_in_project'" size="sm" variant="outline" as-child>
            <RouterLink data-open-team :to="{ path: '/project-agents/manage', query: { project: projectId } }">
              {{ t('projects.workstreams.openTeam') }}
            </RouterLink>
          </Button>
          <Button v-else size="sm" variant="outline" :disabled="Boolean(busy)" data-try-again @click="problem.again()">
            {{ t('projects.overview.retry') }}
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
              <span v-for="term in line.terms" :key="term" class="project-workstreams-term" :data-term="term">
                <UiChip>{{ term }}</UiChip>
                <UiIconButton v-if="line.terms.length > 1" icon="close" size="sm" :disabled="Boolean(busy)"
                  :label="t('projects.workstreams.removeTerm', { term })" data-remove-term
                  @click="removeTerm(line, term)" />
              </span>
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

      <details v-if="closed.length" class="project-workstreams-closed" data-workstreams-closed>
        <summary class="ui-meta">{{ t('projects.workstreams.closed', { count: closed.length }) }}</summary>
        <ul class="project-workstreams-list">
          <li v-for="line in closed" :key="line.assignmentId" class="project-workstreams-item">
            <span class="project-workstreams-main">
              <span>{{ line.name }}</span>
              <span class="ui-meta">{{ line.ownerName ?? line.ownerAgentId }} · {{ line.terms.join(' ') }}</span>
            </span>
            <span class="ui-meta">{{ t('projects.workstreams.endedOn', {
              date: formatDateTime(line.endedAt, currentLocale(), DATE_ONLY, { missing: '' }) }) }}</span>
          </li>
        </ul>
      </details>

      <Button v-if="!draft && candidates.length" size="sm" variant="ghost" data-open-workstream
        @click="startDraft(null)">{{ t('projects.workstreams.open') }}</Button>
      <form v-else-if="draft" ref="form" class="project-workstreams-form" @submit.prevent="submit">
        <p v-if="draft.from" class="ui-meta">{{ t('projects.workstreams.splitFrom', { line: draft.from.name }) }}</p>
        <div v-if="draft.from" class="project-workstreams-chips">
          <Button v-for="term in draft.from.terms" :key="term" type="button" size="xs"
            :variant="draft.picked.includes(term) ? 'secondary' : 'outline'"
            :aria-pressed="draft.picked.includes(term)" :data-term-chip="term" @click="togglePicked(term)">
            {{ term }}
          </Button>
        </div>
        <!-- WORKSTREAM_NAME_LIMIT (src/standing-assignments/limits.js): the lead hands work to a line by name. -->
        <Input v-model="draft.name" size="sm" maxlength="117" :aria-label="t('projects.workstreams.nameLabel')"
          :placeholder="t('projects.workstreams.nameLabel')" data-workstream-name />
        <Input v-model="draft.words" size="sm" :aria-label="t('projects.workstreams.termsLabel')"
          :placeholder="t('projects.workstreams.termsLabel')" data-workstream-words />
        <p v-if="shortWords.length" class="ui-meta" data-short-terms>
          {{ t('projects.workstreams.shortTerms', { terms: shortWords.join('、') }) }}
        </p>
        <OptionSelect v-model="draft.ownerAgentId" size="sm" :options="candidates"
          :label="t('projects.workstreams.ownerLabel')" :placeholder="t('projects.workstreams.ownerLabel')" />
        <Button type="submit" size="sm" :disabled="!canSubmit || Boolean(busy)">{{ t('projects.workstreams.confirm') }}</Button>
        <Button type="button" size="sm" variant="ghost" @click="draft = null">{{ t('projects.workstreams.cancel') }}</Button>
      </form>
    </template>

    <UiDialog :open="Boolean(pending)" size="sm" :title="pendingText.title" :description="pendingText.body"
      data-workstream-confirm @close="pending = null">
      <template #footer>
        <Button size="sm" variant="ghost" @click="pending = null">{{ t('projects.workstreams.cancel') }}</Button>
        <Button size="sm" data-confirm-change @click="confirmPending">{{ pendingText.action }}</Button>
      </template>
    </UiDialog>
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

.project-workstreams-term {
  align-items: center;
  display: inline-flex;
}

.project-workstreams-closed summary {
  cursor: pointer;
}

.project-workstreams-form > p {
  flex-basis: 100%;
  margin: 0;
}
</style>
