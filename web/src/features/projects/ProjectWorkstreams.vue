<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, ref, watch } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import {
  editWorkstreamTerms,
  endWorkstream,
  moveWorkstream,
  openWorkstream,
  readProjectTeam,
  type ProjectTeam,
  type ProjectWorkstream,
} from './project-team-api'

// The lead's ledger on the project page (docs/workstreams.md): which lines of
// work this project is divided into, who does each, and the person's changes
// to that. Each change is one step; nothing is split retroactively.

const props = defineProps<{ spaceId: string; projectId: string }>()

const team = ref<ProjectTeam | null>(null)
const loading = ref(false)
const failed = ref(false)
const busy = ref('')
const error = ref('')
const opening = ref(false)
const draft = ref({ name: '', terms: '', ownerAgentId: '' })
const showLoading = useMinimumLoadingDisplay(computed(() => loading.value && !team.value))
let sequence = 0

const workstreams = computed(() => team.value?.workstreams ?? [])
// Anyone working on the project except its lead: a workstream exists to keep a
// line of work off the lead's desk.
const candidates = computed(() => {
  const value = team.value
  if (!value) return []
  return [...value.members, ...value.collaborators]
    .filter(person => person.agentId !== value.lead?.agentId && !person.peerRole)
})
const canOpen = computed(() => Boolean(draft.value.name.trim() && termsOf(draft.value.terms).length
  && draft.value.ownerAgentId))
// The words of this draft that another line of this project holds today: they
// move here when it opens, so the person sees the split before it happens.
const movingTerms = computed(() => {
  const wanted = termsOf(draft.value.terms).map(term => term.toLowerCase())
  return workstreams.value
    .map(line => ({ line, terms: line.terms.filter(term => wanted.includes(term.toLowerCase())) }))
    .filter(item => item.terms.length)
})

watch(() => [props.spaceId, props.projectId], () => {
  team.value = null
  opening.value = false
  error.value = ''
  void load()
}, { immediate: true })

function termsOf(value: string) {
  return [...new Set(value.split(/[,，;；\s]+/u).map(term => term.trim()).filter(Boolean))]
}

function ownerName(line: ProjectWorkstream) {
  return line.ownerName ?? line.ownerAgentId
}

function startedOn(line: ProjectWorkstream) {
  return formatDateTime(line.startedAt, currentLocale(), DATE_ONLY, { missing: '' })
}

async function load() {
  if (!props.spaceId || !props.projectId) return
  const current = ++sequence
  loading.value = true
  failed.value = false
  try {
    const value = await readProjectTeam(props.spaceId, props.projectId)
    if (current === sequence) team.value = value
  } catch {
    if (current === sequence) failed.value = true
  } finally {
    if (current === sequence) loading.value = false
  }
}

// Every change reads the ledger again, so the next one uses the revision the
// page shows. A refused change leaves the list as it was and says why.
async function change(key: string, work: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = key
  error.value = ''
  try {
    await work()
    await load()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('projects.workstreams.failed')
  } finally {
    busy.value = ''
  }
}

function setOwner(line: ProjectWorkstream, event: Event) {
  const leadAgentId = (event.target as HTMLSelectElement).value
  if (!leadAgentId || leadAgentId === line.ownerAgentId) return
  void change(line.assignmentId, () => moveWorkstream(line.assignmentId,
    { expectedRevision: line.revision, projectId: props.projectId, leadAgentId }))
}

function mergeInto(line: ProjectWorkstream, event: Event) {
  const select = event.target as HTMLSelectElement
  const target = workstreams.value.find(item => item.assignmentId === select.value)
  select.value = ''
  if (!target) return
  void change(line.assignmentId, async () => {
    await editWorkstreamTerms(target.assignmentId, { expectedRevision: target.revision, addTerms: line.terms })
    await endWorkstream(line.assignmentId, line.revision)
  })
}

function end(line: ProjectWorkstream) {
  void change(line.assignmentId, () => endWorkstream(line.assignmentId, line.revision))
}

// Opening a line with words another line holds takes them off that line first,
// which is how a line is split without a second step.
function open() {
  const terms = termsOf(draft.value.terms)
  void change('open', async () => {
    for (const { line, terms: taken } of movingTerms.value) {
      if (taken.length === line.terms.length) await endWorkstream(line.assignmentId, line.revision)
      else await editWorkstreamTerms(line.assignmentId, { expectedRevision: line.revision, removeTerms: taken })
    }
    await openWorkstream(props.projectId, { leadAgentId: draft.value.ownerAgentId, terms,
      responsibility: draft.value.name.trim() })
    draft.value = { name: '', terms: '', ownerAgentId: '' }
    opening.value = false
  })
}
</script>

<template>
  <section v-if="workstreams.length || candidates.length" class="project-workstreams"
    aria-labelledby="project-workstreams-heading">
    <header class="project-workstreams-header">
      <h3 id="project-workstreams-heading">{{ t('projects.workstreams.title') }}</h3>
      <span class="ui-meta">{{ t('projects.workstreams.hint') }}</span>
    </header>

    <GrowthLoading v-if="showLoading" variant="compact" :label="t('projects.workstreams.loading')" />
    <div v-else-if="failed && !team" class="project-workstreams-state" role="alert">
      <p>{{ t('projects.workstreams.failed') }}</p>
      <Button size="sm" variant="ghost" @click="load">{{ t('projects.overview.retry') }}</Button>
    </div>

    <template v-else>
      <p v-if="error" class="project-workstreams-error" role="alert">{{ error }}</p>
      <p v-if="!workstreams.length" class="ui-meta" data-workstreams-empty>
        {{ t('projects.workstreams.none') }}
      </p>
      <ul v-else class="project-workstreams-list">
        <li v-for="line in workstreams" :key="line.assignmentId" class="project-workstreams-item"
          :data-workstream="line.assignmentId">
          <div class="project-workstreams-main">
            <strong class="project-workstreams-name">{{ line.name }}</strong>
            <label class="project-workstreams-owner">
              <span class="sr-only">{{ t('projects.workstreams.owner', { name: line.name }) }}</span>
              <select :value="line.ownerAgentId" :disabled="Boolean(busy)" @change="setOwner(line, $event)">
                <option v-if="!line.ownerOnProject" :value="line.ownerAgentId">
                  {{ t('projects.workstreams.ownerGone', { name: ownerName(line) }) }}
                </option>
                <option v-for="person in candidates" :key="person.agentId" :value="person.agentId">
                  {{ person.name }}
                </option>
              </select>
            </label>
            <span class="project-workstreams-terms">{{ line.terms.join(' · ') }}</span>
          </div>
          <div class="project-workstreams-side">
            <span class="ui-meta">
              {{ t('projects.workstreams.started', { date: startedOn(line) }) }} ·
              {{ t(line.decidedBy === 'user' ? 'projects.workstreams.byYou' : 'projects.workstreams.byLead') }}
            </span>
            <label v-if="workstreams.length > 1" class="project-workstreams-merge">
              <span class="sr-only">{{ t('projects.workstreams.merge', { name: line.name }) }}</span>
              <select value="" :disabled="Boolean(busy)" @change="mergeInto(line, $event)">
                <option value="">{{ t('projects.workstreams.mergeInto') }}</option>
                <option v-for="target in workstreams.filter(item => item.assignmentId !== line.assignmentId)"
                  :key="target.assignmentId" :value="target.assignmentId">{{ target.name }}</option>
              </select>
            </label>
            <Button size="icon-sm" variant="ghost" :disabled="Boolean(busy)"
              :aria-label="t('projects.workstreams.end', { name: line.name })"
              :title="t('projects.workstreams.end', { name: line.name })"
              @click="end(line)">
              <svg class="project-team-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </Button>
          </div>
        </li>
      </ul>

      <Button v-if="!opening && candidates.length" size="sm" variant="ghost" data-open-workstream
        @click="opening = true">
        {{ t('projects.workstreams.open') }}
      </Button>
      <form v-else-if="opening" class="project-workstreams-form" @submit.prevent="open">
        <label>
          <span class="sr-only">{{ t('projects.workstreams.nameLabel') }}</span>
          <input v-model="draft.name" :placeholder="t('projects.workstreams.nameLabel')" maxlength="240">
        </label>
        <label>
          <span class="sr-only">{{ t('projects.workstreams.termsLabel') }}</span>
          <input v-model="draft.terms" :placeholder="t('projects.workstreams.termsLabel')">
        </label>
        <label>
          <span class="sr-only">{{ t('projects.workstreams.ownerLabel') }}</span>
          <select v-model="draft.ownerAgentId">
            <option value="">{{ t('projects.workstreams.ownerLabel') }}</option>
            <option v-for="person in candidates" :key="person.agentId" :value="person.agentId">{{ person.name }}</option>
          </select>
        </label>
        <Button type="submit" size="sm" :disabled="!canOpen || Boolean(busy)">
          {{ t('projects.workstreams.confirm') }}
        </Button>
        <Button type="button" size="sm" variant="ghost" @click="opening = false">
          {{ t('projects.workstreams.cancel') }}
        </Button>
        <p v-for="item in movingTerms" :key="item.line.assignmentId" class="ui-meta project-workstreams-moving">
          {{ t('projects.workstreams.moving', { terms: item.terms.join(' · '), from: item.line.name }) }}
        </p>
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
.project-workstreams-side {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.project-workstreams-terms {
  color: var(--muted-foreground);
  font-size: 0.875rem;
}

.project-workstreams-form {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.project-workstreams-moving {
  flex-basis: 100%;
}

.project-workstreams-error {
  color: var(--destructive);
}
</style>
