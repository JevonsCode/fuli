<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { getJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { formatTime } from '@/features/knowledge/model'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'

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
const loading = ref(false)
const maintainableProjects = computed(() =>
  (store.state?.projects ?? []).filter(({ role }) => role === 'maintainer'),
)
const reviewProjectOptions = computed(() =>
  maintainableProjects.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const reviewProject = computed(
  () => maintainableProjects.value.find(({ id }) => id === reviewProjectId.value) ?? null,
)

watch(
  () => store.state,
  (state) => {
    if (!state) return
    if (!reviewProjectId.value) reviewProjectId.value = maintainableProjects.value[0]?.id ?? ''
    void load()
  },
  { immediate: true },
)
watch(reviewProjectId, () => void loadShared())

async function load() {
  loading.value = true
  await Promise.all([loadPersonal(), loadShared()])
  loading.value = false
}

async function loadPersonal() {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId) return
  try {
    const query = new URLSearchParams({ personalSpaceId, status: 'pending' })
    const result = await getJson<{ drafts?: PersonalDraft[] }>(`/api/personal-review?${query}`)
    personalDrafts.value = result.drafts ?? []
  } catch (error) {
    store.reportError(error)
  }
}

async function loadShared() {
  const project = reviewProject.value
  if (!project) {
    proposals.value = []
    return
  }
  try {
    const query = new URLSearchParams({
      projectId: project.id,
      providerUrl: project.providerUrl,
      status: 'pending',
    })
    const result = await getJson<{ proposals?: Proposal[] }>(`/api/review?${query}`)
    proposals.value = result.proposals ?? []
  } catch (error) {
    proposals.value = []
    store.reportError(error)
  }
}

async function decidePersonal(draft: PersonalDraft, decision: string) {
  try {
    await postJson(`/api/personal-review/${encodeURIComponent(draft.id)}/decision`, { decision })
    await Promise.all([loadPersonal(), store.refresh()])
  } catch (error) {
    store.reportError(error)
  }
}

async function decideShared(proposal: Proposal, decision: string) {
  const project = reviewProject.value
  if (!project) return
  try {
    await postJson(`/api/review/${encodeURIComponent(proposal.id)}/decision`, {
      projectId: project.id,
      providerUrl: project.providerUrl,
      decision,
      note: null,
    })
    await loadShared()
  } catch (error) {
    store.reportError(error)
  }
}
</script>

<template>
  <section class="view">
    <div class="section-title"><h3>{{ t('pages.review.personalTitle') }}</h3><p>{{ t('pages.review.personalCopy') }}</p></div>
    <div class="review-list">
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
          <button class="secondary-action" type="button" @click="decidePersonal(draft, 'keep_personal')">{{ t('pages.review.keepPersonal') }}</button>
          <button class="reject" type="button" @click="decidePersonal(draft, 'ignore')">{{ t('pages.review.ignore') }}</button>
          <button v-if="store.state?.capabilities?.submitKnowledge" class="approve" type="button" @click="decidePersonal(draft, 'submit_public')">{{ t('pages.review.submitPublic') }}</button>
        </div>
      </article>
      <div v-if="!loading && !personalDrafts.length" class="empty-state">{{ t('pages.review.noPersonalDrafts') }}</div>
    </div>

    <section v-if="store.state?.capabilities?.reviewProposals" class="project-section">
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
      <div class="review-list">
        <article v-for="proposal in proposals" :key="proposal.id" class="review-item">
          <div>
            <div class="review-stage">{{ t('pages.review.maintainerReview') }}</div>
            <h4>{{ proposal.episode.name }}</h4>
            <p>{{ proposal.episode.summary || proposal.episode.source_description }}</p>
            <div class="review-meta"><span>{{ formatTime(proposal.created_at) }}</span></div>
          </div>
          <div class="review-actions">
            <button class="reject" type="button" @click="decideShared(proposal, 'reject')">{{ t('pages.review.reject') }}</button>
            <button class="approve" type="button" @click="decideShared(proposal, 'approve')">{{ t('pages.review.approve') }}</button>
          </div>
        </article>
        <div v-if="!loading && !proposals.length" class="empty-state">{{ t('pages.review.noProposals') }}</div>
      </div>
    </section>
  </section>
</template>
