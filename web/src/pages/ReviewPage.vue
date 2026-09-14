<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { getJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { formatTime } from '@/features/knowledge/model'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { ConsoleState, PublicProject } from '@/types'

type ReviewEpisode = {
  name: string
  summary?: string
  source_description?: string
  entities?: unknown[]
  relationships?: unknown[]
}
type PersonalDraft = { id: string; created_at?: string; episode: ReviewEpisode }
type Proposal = { id: string; created_at?: string; episode: ReviewEpisode }

const store = useConsoleStore()
const personalDrafts = ref<PersonalDraft[]>([])
const proposals = ref<Proposal[]>([])
const reviewProjectId = ref('')

const personalLoading = ref(false)
const personalError = ref('')
const sharedLoading = ref(false)
const sharedError = ref('')
const personalDecisionBusy = ref(new Set<string>())
const sharedDecisionBusy = ref(new Set<string>())

let personalVersion = 0
let personalController: AbortController | null = null
let sharedVersion = 0
let sharedController: AbortController | null = null

const maintainableProjects = computed(() =>
  (store.state?.projects ?? []).filter((project) =>
    project.role === 'maintainer' && providerSupportsReview(project),
  ),
)
const reviewProjectOptions = computed(() =>
  maintainableProjects.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: '#' + compactIdentity(project.id, 26),
    search: identitySearchText(project.id),
  })),
)
const reviewProject = computed(
  () => maintainableProjects.value.find(({ id }) => id === reviewProjectId.value) ?? null,
)
const reviewProjectKey = computed(() => {
  const project = reviewProject.value
  return project ? project.id + '\u0000' + project.providerUrl : ''
})

function providerSupportsReview(project: PublicProject) {
  return providerSupportsReviewInState(store.state, project)
}

function providerSupportsReviewInState(state: ConsoleState | null, project: PublicProject) {
  if (state?.capabilities?.reviewProposals !== true) return false
  const provider = state.providers?.workspaces?.find(
    ({ providerUrl }) => providerUrl === project.providerUrl,
  )
  if (!provider || provider.status !== 'ready') return false
  const capabilities = provider.capabilities
  return Boolean(
    capabilities
    && typeof capabilities === 'object'
    && (capabilities as Record<string, unknown>).reviewProposals === true,
  )
}

function activePersonalSpaceIdForState(state: ConsoleState | null) {
  if (!state) return ''
  return state.personalSpaces.find(({ id }) => id === state.activePersonalSpaceId)?.id
    ?? state.personalSpaces[0]?.id
    ?? ''
}

function reviewProjectKeyForState(state: ConsoleState | null, projectId: string) {
  const project = (state?.projects ?? []).find((candidate) =>
    candidate.id === projectId
    && candidate.role === 'maintainer'
    && providerSupportsReviewInState(state, candidate),
  )
  return project ? project.id + '\u0000' + project.providerUrl : ''
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : t('common.errors.loadFailed')
}

function isAbortError(error: unknown) {
  return Boolean(
    error
    && typeof error === 'object'
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError',
  )
}

function setBusy(target: typeof personalDecisionBusy, key: string, busy: boolean) {
  const next = new Set(target.value)
  if (busy) next.add(key)
  else next.delete(key)
  target.value = next
}

function resetPersonalQueue() {
  personalVersion += 1
  personalController?.abort()
  personalController = null
  personalDrafts.value = []
  personalError.value = ''
  personalLoading.value = false
}

function resetSharedQueue() {
  sharedVersion += 1
  sharedController?.abort()
  sharedController = null
  proposals.value = []
  sharedError.value = ''
  sharedLoading.value = false
}

function currentPersonalQueue(spaceId: string, version: number) {
  return version === personalVersion && store.activePersonalSpace?.id === spaceId
}

function currentSharedQueue(project: PublicProject, version: number) {
  const current = reviewProject.value
  return version === sharedVersion
    && current?.id === project.id
    && current.providerUrl === project.providerUrl
}

function personalItemIsCurrent(draft: PersonalDraft, version: number, spaceId: string) {
  return currentPersonalQueue(spaceId, version)
    && personalDrafts.value.some(({ id }) => id === draft.id)
}

function sharedItemIsCurrent(proposal: Proposal, project: PublicProject, version: number) {
  return currentSharedQueue(project, version)
    && proposals.value.some(({ id }) => id === proposal.id)
}

function sharedBusyKey(projectId: string, proposalId: string) {
  return projectId + '\u0000' + proposalId
}

async function loadPersonal(spaceId = store.activePersonalSpace?.id) {
  personalController?.abort()
  const version = ++personalVersion
  const controller = new AbortController()
  personalController = controller
  personalLoading.value = true
  personalError.value = ''
  if (!spaceId) {
    personalLoading.value = false
    if (personalController === controller) personalController = null
    return
  }
  try {
    const query = new URLSearchParams({ personalSpaceId: spaceId, status: 'pending' })
    const result = await getJson<{ drafts?: PersonalDraft[] }>(
      '/api/personal-review?' + query,
      { signal: controller.signal },
    )
    if (!currentPersonalQueue(spaceId, version) || controller.signal.aborted) return
    personalDrafts.value = result.drafts ?? []
  } catch (error) {
    if (!currentPersonalQueue(spaceId, version) || controller.signal.aborted || isAbortError(error)) return
    personalError.value = errorMessage(error)
  } finally {
    if (version === personalVersion && personalController === controller) {
      personalLoading.value = false
      personalController = null
    }
  }
}

async function loadShared() {
  const project = reviewProject.value
  if (!project) return
  sharedController?.abort()
  const version = ++sharedVersion
  const controller = new AbortController()
  sharedController = controller
  sharedLoading.value = true
  sharedError.value = ''
  try {
    const query = new URLSearchParams({
      projectId: project.id,
      providerUrl: project.providerUrl,
      status: 'pending',
    })
    const result = await getJson<{ proposals?: Proposal[] }>(
      '/api/review?' + query,
      { signal: controller.signal },
    )
    if (!currentSharedQueue(project, version) || controller.signal.aborted) return
    proposals.value = result.proposals ?? []
  } catch (error) {
    if (!currentSharedQueue(project, version) || controller.signal.aborted || isAbortError(error)) return
    sharedError.value = errorMessage(error)
  } finally {
    if (version === sharedVersion && sharedController === controller) {
      sharedLoading.value = false
      sharedController = null
    }
  }
}

async function decidePersonal(draft: PersonalDraft, decision: string) {
  const spaceId = store.activePersonalSpace?.id
  const version = personalVersion
  if (
    !spaceId
    || personalLoading.value
    || personalError.value
    || !personalItemIsCurrent(draft, version, spaceId)
  ) return
  if (personalDecisionBusy.value.has(draft.id)) return
  setBusy(personalDecisionBusy, draft.id, true)
  try {
    if (
      personalLoading.value
      || personalError.value
      || !personalItemIsCurrent(draft, version, spaceId)
    ) return
    await postJson('/api/personal-review/' + encodeURIComponent(draft.id) + '/decision', { decision })
    if (!currentPersonalQueue(spaceId, version)) return
    await Promise.all([loadPersonal(spaceId), store.refresh()])
  } catch (error) {
    if (currentPersonalQueue(spaceId, version) && !isAbortError(error)) {
      personalError.value = errorMessage(error)
    }
  } finally {
    setBusy(personalDecisionBusy, draft.id, false)
  }
}

async function decideShared(proposal: Proposal, decision: string) {
  const project = reviewProject.value
  const version = sharedVersion
  if (
    !project
    || sharedLoading.value
    || sharedError.value
    || !sharedItemIsCurrent(proposal, project, version)
  ) return
  const busyKey = sharedBusyKey(project.id, proposal.id)
  if (sharedDecisionBusy.value.has(busyKey)) return
  setBusy(sharedDecisionBusy, busyKey, true)
  try {
    if (
      sharedLoading.value
      || sharedError.value
      || !sharedItemIsCurrent(proposal, project, version)
    ) return
    await postJson('/api/review/' + encodeURIComponent(proposal.id) + '/decision', {
      projectId: project.id,
      providerUrl: project.providerUrl,
      decision,
      note: null,
    })
    if (!currentSharedQueue(project, version)) return
    await loadShared()
  } catch (error) {
    if (currentSharedQueue(project, version) && !isAbortError(error)) {
      sharedError.value = errorMessage(error)
    }
  } finally {
    setBusy(sharedDecisionBusy, busyKey, false)
  }
}

watch(
  () => store.state,
  (state, previousState) => {
    if (!state || !previousState) return
    const previousSpaceId = activePersonalSpaceIdForState(previousState)
    const spaceId = activePersonalSpaceIdForState(state)
    if (spaceId && spaceId === previousSpaceId) void loadPersonal(spaceId)

    const selectedProjectId = reviewProjectId.value
    const previousProjectKey = reviewProjectKeyForState(previousState, selectedProjectId)
    const projectKey = reviewProjectKeyForState(state, selectedProjectId)
    if (projectKey && projectKey === previousProjectKey) void loadShared()
  },
  { flush: 'sync' },
)

watch(
  () => store.activePersonalSpace?.id ?? '',
  (spaceId) => {
    resetPersonalQueue()
    if (spaceId) void loadPersonal(spaceId)
  },
  { immediate: true, flush: 'sync' },
)

watch(
  maintainableProjects,
  (projects) => {
    if (!projects.some(({ id }) => id === reviewProjectId.value)) {
      reviewProjectId.value = projects[0]?.id ?? ''
    }
  },
  { immediate: true, flush: 'sync' },
)

watch(
  reviewProjectKey,
  () => {
    resetSharedQueue()
    if (reviewProject.value) void loadShared()
  },
  { immediate: true, flush: 'sync' },
)

onBeforeUnmount(() => {
  resetPersonalQueue()
  resetSharedQueue()
})
</script>

<template>
  <section class="view">
    <div class="section-title"><h3>{{ t('pages.review.personalTitle') }}</h3><p>{{ t('pages.review.personalCopy') }}</p></div>
    <div class="review-list" data-review-queue="personal">
      <GrowthLoading v-if="personalLoading" variant="compact" :label="t('pages.review.loadingPersonal')" />
      <div v-if="personalError" class="review-error" role="alert">
        <span>{{ personalError }}</span>
        <button class="secondary-action" type="button" :disabled="personalLoading" @click="loadPersonal()">{{ t('common.actions.retry') }}</button>
      </div>
      <article v-for="draft in personalDrafts" :key="draft.id" class="review-item review-item-detailed">
        <div>
          <div class="review-stage">{{ t('pages.review.beforePublic') }}</div>
          <h4>{{ draft.episode.name }}</h4>
          <p>{{ draft.episode.summary || draft.episode.source_description }}</p>
          <div class="review-meta">
            <span>{{ t('common.counts.entities', { count: draft.episode.entities?.length ?? 0 }) }}</span>
            <span>{{ t('common.counts.relationships', { count: draft.episode.relationships?.length ?? 0 }) }}</span>
            <span>{{ formatTime(draft.created_at) }}</span>
          </div>
        </div>
        <div class="review-actions stacked-actions">
          <GrowthLoading v-if="personalDecisionBusy.has(draft.id)" variant="inline" :label="t('pages.review.savingDecision')" />
          <button class="secondary-action" type="button" :disabled="personalLoading || personalError !== '' || personalDecisionBusy.has(draft.id)" @click="decidePersonal(draft, 'keep_personal')">{{ t('pages.review.keepPersonal') }}</button>
          <button class="reject" type="button" :disabled="personalLoading || personalError !== '' || personalDecisionBusy.has(draft.id)" @click="decidePersonal(draft, 'ignore')">{{ t('pages.review.ignore') }}</button>
          <button v-if="store.state?.capabilities?.submitKnowledge" class="approve" type="button" :disabled="personalLoading || personalError !== '' || personalDecisionBusy.has(draft.id)" @click="decidePersonal(draft, 'submit_public')">{{ t('pages.review.submitPublic') }}</button>
        </div>
      </article>
      <div v-if="!personalLoading && !personalError && !personalDrafts.length" class="empty-state">{{ t('pages.review.noPersonalDrafts') }}</div>
    </div>

    <section v-if="store.state?.capabilities?.reviewProposals && maintainableProjects.length" class="project-section">
      <div class="section-toolbar">
        <div><h3>{{ t('pages.review.publicTitle') }}</h3><p>{{ t('pages.review.publicCopy') }}</p></div>
        <SearchableSelect
          v-model="reviewProjectId"
          :options="reviewProjectOptions"
          :label="t('pages.review.projectLabel')"
          control-id="review-project"
          searchable
        />
      </div>
      <div class="review-list" data-review-queue="shared">
        <GrowthLoading v-if="sharedLoading" variant="compact" :label="t('pages.review.loadingPublic')" />
        <div v-if="sharedError" class="review-error" role="alert">
          <span>{{ sharedError }}</span>
          <button class="secondary-action" type="button" :disabled="sharedLoading" @click="loadShared()">{{ t('common.actions.retry') }}</button>
        </div>
        <article v-for="proposal in proposals" :key="proposal.id" class="review-item">
          <div>
            <div class="review-stage">{{ t('pages.review.maintainerReview') }}</div>
            <h4>{{ proposal.episode.name }}</h4>
            <p>{{ proposal.episode.summary || proposal.episode.source_description }}</p>
            <div class="review-meta"><span>{{ formatTime(proposal.created_at) }}</span></div>
          </div>
          <div class="review-actions">
            <GrowthLoading v-if="sharedDecisionBusy.has(sharedBusyKey(reviewProjectId, proposal.id))" variant="inline" :label="t('pages.review.savingDecision')" />
            <button class="reject" type="button" :disabled="sharedLoading || sharedError !== '' || sharedDecisionBusy.has(sharedBusyKey(reviewProjectId, proposal.id))" @click="decideShared(proposal, 'reject')">{{ t('pages.review.reject') }}</button>
            <button class="approve" type="button" :disabled="sharedLoading || sharedError !== '' || sharedDecisionBusy.has(sharedBusyKey(reviewProjectId, proposal.id))" @click="decideShared(proposal, 'approve')">{{ t('pages.review.approve') }}</button>
          </div>
        </article>
        <div v-if="!sharedLoading && !sharedError && !proposals.length" class="empty-state">{{ t('pages.review.noProposals') }}</div>
      </div>
    </section>
  </section>
</template>
