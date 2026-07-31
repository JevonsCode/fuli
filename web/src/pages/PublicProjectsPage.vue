<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { deleteJson, getJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { currentLocale, t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { knowledgePath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'
import type { ProjectRelease, PublicProject } from '@/types'

type ProjectRelation = {
  id: string
  source_project_id: string
  target_project_id: string
  relation_type: string
  status?: string
}

const store = useConsoleStore()
const router = useRouter()
const selectedProject = ref<PublicProject | null>(null)
const releases = ref<ProjectRelease[]>([])
const relations = ref<ProjectRelation[]>([])
const detailLoading = ref(false)
const relationOpen = ref(false)
const relationSource = ref('')
const relationTarget = ref('')
const relationType = ref('RELATED_TO')
const deletionProject = ref<PublicProject | null>(null)
const deletionName = ref('')
const deletionBusy = ref(false)
const deletionError = ref('')

const projects = computed(() => store.state?.projects ?? [])
const subscribedKeys = computed(
  () => new Set(
    (store.state?.subscriptions ?? []).map(
      ({ provider_url, project_id }) => `${provider_url}::${project_id}`,
    ),
  ),
)
const maintainable = computed(() =>
  projects.value.filter(({ role, isOwner }) => role === 'maintainer' || isOwner),
)
const maintainableOptions = computed(() =>
  maintainable.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const relationTargets = computed(() => {
  const source = projects.value.find(({ id }) => id === relationSource.value)
  return projects.value.filter(
    ({ id, providerUrl }) => id !== source?.id && providerUrl === source?.providerUrl,
  )
})
const relationTargetOptions = computed(() =>
  relationTargets.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const relationSourceProject = computed(
  () => projects.value.find(({ id }) => id === relationSource.value) ?? null,
)
const relationTargetProject = computed(
  () => projects.value.find(({ id }) => id === relationTarget.value) ?? null,
)
const relationTypeLabel = computed(
  () => relationTypeOptions.value.find(({ value }) => value === relationType.value)?.label
    ?? t('pages.publicProjects.relationLabels.relatedTo'),
)
const deletionMatches = computed(
  () => Boolean(deletionProject.value && deletionName.value === deletionProject.value.name),
)
const relationTypeOptions = computed(() => [
  { value: 'PART_OF', label: t('pages.publicProjects.relationLabels.partOf') },
  {
    value: 'USES_KNOWLEDGE_FROM',
    label: t('pages.publicProjects.relationLabels.usesKnowledgeFrom'),
  },
  { value: 'DEPENDS_ON', label: t('pages.publicProjects.relationLabels.dependsOn') },
  { value: 'PROVIDES_TO', label: t('pages.publicProjects.relationLabels.providesTo') },
  {
    value: 'SHARES_CAPABILITY_WITH',
    label: t('pages.publicProjects.relationLabels.sharesCapabilityWith'),
  },
  { value: 'SUCCESSOR_OF', label: t('pages.publicProjects.relationLabels.successorOf') },
  { value: 'RELATED_TO', label: t('pages.publicProjects.relationLabels.relatedTo') },
])

function projectKey(project: PublicProject) {
  return `${project.providerUrl}::${project.id}`
}

function projectPurpose(project: PublicProject) {
  return project.profile?.purpose
    || project.profile?.scope
    || project.profile?.technical_summary
    || project.description
    || t('pages.publicProjects.fallbackDescription')
}

async function toggleSubscription(project: PublicProject) {
  try {
    if (subscribedKeys.value.has(projectKey(project))) {
      const query = new URLSearchParams({
        personalSpaceId: store.activePersonalSpace?.id ?? '',
        providerUrl: project.providerUrl,
      })
      await deleteJson(`/api/subscriptions/${encodeURIComponent(project.id)}?${query}`)
      store.notify(t('pages.publicProjects.unsubscribed', { name: project.name }))
    } else {
      await postJson('/api/subscriptions', {
        personalSpaceId: store.activePersonalSpace?.id,
        projectId: project.id,
        providerUrl: project.providerUrl,
        projectName: project.name,
      })
      store.notify(t('pages.publicProjects.subscribed', { name: project.name }))
    }
    await store.refresh()
  } catch (error) {
    store.reportError(error)
  }
}

async function openDetails(project: PublicProject) {
  selectedProject.value = project
  releases.value = []
  relations.value = []
  detailLoading.value = true
  try {
    const provider = new URLSearchParams({ providerUrl: project.providerUrl })
    const [releaseResult, relationResult] = await Promise.all([
      getJson<{ releases?: ProjectRelease[] }>(
        `/api/projects/${encodeURIComponent(project.id)}/releases?${provider}`,
      ),
      getJson<{ relations?: ProjectRelation[] }>(
        `/api/project-relations?${new URLSearchParams({
          projectId: project.id,
          providerUrl: project.providerUrl,
        })}`,
      ),
    ])
    releases.value = releaseResult.releases ?? []
    relations.value = relationResult.relations ?? []
  } catch (error) {
    store.reportError(error)
  } finally {
    detailLoading.value = false
  }
}

async function openGraph(project: PublicProject) {
  selectedProject.value = null
  await router.push(knowledgePath('public', project.id, 'graph'))
}

function openProjectDeletion(project: PublicProject) {
  deletionProject.value = project
  deletionName.value = ''
  deletionError.value = ''
}

function closeProjectDeletion() {
  if (deletionBusy.value) return
  deletionProject.value = null
  deletionName.value = ''
  deletionError.value = ''
}

async function deleteProject() {
  const project = deletionProject.value
  if (!project || !deletionMatches.value) {
    deletionError.value = t('pages.publicProjects.deleteNameRequired')
    return
  }
  deletionBusy.value = true
  deletionError.value = ''
  try {
    const query = new URLSearchParams({ providerUrl: project.providerUrl })
    await deleteJson(`/api/projects/${encodeURIComponent(project.id)}?${query}`)
    selectedProject.value = null
    deletionProject.value = null
    store.notify(t('pages.publicProjects.deleted', { name: project.name }))
    await store.refresh()
  } catch (error) {
    deletionError.value = error instanceof Error
      ? error.message
      : t('pages.publicProjects.deleteFailed')
    store.reportError(error)
  } finally {
    deletionBusy.value = false
  }
}

async function createRelation() {
  const source = projects.value.find(({ id }) => id === relationSource.value)
  const target = projects.value.find(({ id }) => id === relationTarget.value)
  if (!source || !target) {
    store.reportError(new Error(t('pages.publicProjects.chooseRelationProjects')))
    return
  }
  try {
    await postJson('/api/project-relations', {
      sourceProjectId: source.id,
      targetProjectId: target.id,
      providerUrl: source.providerUrl,
      relationType: relationType.value,
      note: null,
    })
    relationOpen.value = false
    relationSource.value = ''
    relationTarget.value = ''
    store.notify(
      relationType.value === 'PART_OF'
        ? t('pages.publicProjects.parentRelationSubmitted')
        : t('pages.publicProjects.relationCreated'),
    )
  } catch (error) {
    store.reportError(error)
  }
}

function formatDate(value?: string) {
  return value
    ? new Date(value).toLocaleString(currentLocale())
    : t('pages.publicProjects.timeNotRecorded')
}
</script>

<template>
  <section class="view">
    <div class="space-heading public-space-heading">
      <span class="space-heading-icon" aria-hidden="true"><span class="nav-icon nav-icon-public-project" /></span>
      <div><p>{{ t('pages.publicProjects.intro') }}</p></div>
      <div class="public-space-stats" :aria-label="t('pages.publicProjects.overviewAria')">
        <span><strong>{{ projects.length }}</strong>{{ t('pages.publicProjects.discoverable') }}</span>
        <span><strong>{{ store.state?.subscriptions.length ?? 0 }}</strong>{{ t('pages.publicProjects.subscribedCount') }}</span>
      </div>
    </div>

    <div class="project-grid">
      <article v-for="project in projects" :key="projectKey(project)" class="project-card">
        <div class="project-card-heading">
          <div><p class="eyebrow">PUBLIC PROJECT</p><h4>{{ project.name }}</h4></div>
          <div class="project-card-heading-actions">
            <button
              v-if="project.can_manage"
              class="management-action"
              type="button"
              @click="openProjectDeletion(project)"
            >
              {{ t('pages.publicProjects.manage') }}
            </button>
            <div class="completion-badge">
              <strong>{{ project.profile?.assessment?.score ?? '—' }}</strong>
              <span>{{ project.profile?.assessment ? t('pages.publicProjects.coverage') : t('pages.publicProjects.noSummary') }}</span>
            </div>
          </div>
        </div>
        <p class="project-purpose">{{ projectPurpose(project) }}</p>
        <div class="evidence-row">
          <span v-for="(source, index) in project.profile?.sources ?? []" :key="index" class="status-chip">{{ source.kind ?? t('pages.publicProjects.material') }}</span>
          <span v-if="!project.profile?.sources?.length" class="muted">{{ t('pages.publicProjects.noSources') }}</span>
        </div>
        <div class="project-access">
          <span class="status-chip" :class="{ owner: project.isOwner }">{{ project.isOwner ? 'Owner' : project.role ?? 'Reader' }}</span>
          <span class="muted">{{ project.isOwner ? t('pages.publicProjects.publishedByYou') : t('pages.publicProjects.publiclyDiscoverable') }}</span>
          <span v-if="project.current_release" class="project-release-meta">
            <strong>{{ project.current_release.version }}</strong>
            <span>{{ formatDate(project.current_release.published_at) }}</span>
          </span>
        </div>
        <footer class="project-card-footer">
          <button class="secondary-action" type="button" @click="toggleSubscription(project)">
            {{ subscribedKeys.has(projectKey(project)) ? t('pages.publicProjects.unsubscribe') : t('pages.publicProjects.subscribe') }}
          </button>
          <button class="primary-action" type="button" @click="openDetails(project)">{{ t('common.actions.viewDetails') }}</button>
        </footer>
      </article>
      <div v-if="!projects.length" class="empty-state project-empty">{{ t('pages.publicProjects.noProjects') }}</div>
    </div>

    <section class="project-section">
      <div class="section-toolbar compact-toolbar relation-section-toolbar">
        <div><p class="eyebrow">PROJECT RELATIONS</p><h3>{{ t('pages.publicProjects.relationsTitle') }}</h3><p>{{ t('pages.publicProjects.relationsCopy') }}</p></div>
        <button class="primary-action" type="button" :disabled="!maintainable.length" @click="relationOpen = !relationOpen">
          {{ t('pages.publicProjects.addRelation') }}
        </button>
      </div>
      <form v-if="relationOpen" class="relation-composer relation-composer-form compact-relation-form" @submit.prevent="createRelation">
        <label>{{ t('pages.publicProjects.sourceProject') }}
          <SearchableSelect
            v-model="relationSource"
            :options="maintainableOptions"
            :label="t('pages.publicProjects.sourceProjectLabel')"
            :placeholder="t('pages.publicProjects.chooseProject')"
            searchable
            required
            @change="relationTarget = ''"
          />
        </label>
        <label>{{ t('pages.publicProjects.relation') }}
          <SearchableSelect
            v-model="relationType"
            :options="relationTypeOptions"
            :label="t('pages.publicProjects.relationTypeLabel')"
          />
        </label>
        <label>{{ t('pages.publicProjects.targetProject') }}
          <SearchableSelect
            v-model="relationTarget"
            :options="relationTargetOptions"
            :label="t('pages.publicProjects.targetProjectLabel')"
            :placeholder="t('pages.publicProjects.chooseProject')"
            searchable
            required
          />
        </label>
        <div class="compact-relation-preview" aria-live="polite">
          <span>{{ t('pages.publicProjects.preview') }}</span>
          <strong>
            {{ relationSourceProject?.name || t('pages.publicProjects.sourceProject') }}
            {{ relationTypeLabel }}
            {{ relationTargetProject?.name || t('pages.publicProjects.targetProject') }}
          </strong>
          <p v-if="relationType === 'PART_OF'">
            {{ t('pages.publicProjects.parentConfirmation') }}
          </p>
          <p v-else>{{ t('pages.publicProjects.relationBoundary') }}</p>
        </div>
        <button class="primary-action" type="submit">{{ t('pages.publicProjects.addRelation') }}</button>
      </form>
    </section>

    <dialog :open="Boolean(selectedProject)" class="project-dialog vue-dialog">
      <div v-if="selectedProject" class="project-dialog-shell">
        <header class="project-dialog-header">
          <div><p class="eyebrow">PUBLIC PROJECT</p><h3>{{ selectedProject.name }}</h3><p>{{ projectPurpose(selectedProject) }}</p></div>
          <button class="secondary-action" type="button" @click="selectedProject = null">{{ t('common.actions.close') }}</button>
        </header>
        <section class="project-latest-release">
          <p class="eyebrow">LATEST RELEASE</p>
          <h4>{{ t('pages.publicProjects.latestRelease') }}</h4>
          <p v-if="selectedProject.current_release">
            <strong>{{ selectedProject.current_release.version }}</strong>
            · {{ formatDate(selectedProject.current_release.published_at) }}
          </p>
          <p v-else class="muted">{{ t('pages.publicProjects.noRelease') }}</p>
        </section>
        <div class="project-detail-columns">
          <section>
            <h4>{{ t('pages.publicProjects.releaseHistory') }}</h4>
            <p v-if="detailLoading" class="muted">{{ t('pages.publicProjects.loading') }}</p>
            <article v-for="release in releases" :key="release.version" class="project-release-item">
              <strong>{{ release.version }}</strong><p>{{ release.update_summary }}</p><small>{{ formatDate(release.published_at) }}</small>
            </article>
            <p v-if="!detailLoading && !releases.length" class="muted">{{ t('pages.publicProjects.noReleaseHistory') }}</p>
          </section>
          <section>
            <h4>{{ t('pages.publicProjects.relationsTitle') }}</h4>
            <article v-for="relation in relations" :key="relation.id" class="project-detail-relation">
              <strong>{{ relation.relation_type }}</strong><small>{{ relation.status ?? 'active' }}</small>
            </article>
            <p v-if="!detailLoading && !relations.length" class="muted">{{ t('pages.publicProjects.noRelations') }}</p>
          </section>
        </div>
        <footer class="project-dialog-actions">
          <span>{{ t('pages.publicProjects.contentManagementSeparated') }}</span>
          <button class="primary-action" type="button" @click="openGraph(selectedProject)">{{ t('pages.publicProjects.viewGraph') }}</button>
        </footer>
      </div>
    </dialog>

    <dialog :open="Boolean(deletionProject)" class="project-dialog vue-dialog">
      <div v-if="deletionProject" class="project-dialog-shell">
        <header class="project-dialog-header">
          <div>
            <p class="eyebrow">DESTRUCTIVE ACTION</p>
            <h3>{{ t('pages.publicProjects.deleteTitle') }}</h3>
            <p>{{ t('pages.publicProjects.deleteCopy') }}</p>
          </div>
          <button
            class="secondary-action"
            type="button"
            :disabled="deletionBusy"
            @click="closeProjectDeletion"
          >
            {{ t('common.actions.close') }}
          </button>
        </header>
        <label class="project-delete-confirmation">
          {{ t('pages.publicProjects.enterFullName') }} <strong>{{ deletionProject.name }}</strong>
          <input
            v-model="deletionName"
            autocomplete="off"
            :disabled="deletionBusy"
          />
        </label>
        <p v-if="deletionError" class="publish-dialog-error" role="alert">
          {{ deletionError }}
        </p>
        <footer class="project-dialog-actions">
          <span>{{ t('pages.publicProjects.deleteWarning') }}</span>
          <button
            class="reject"
            type="button"
            :disabled="!deletionMatches || deletionBusy"
            @click="deleteProject"
          >
            {{ deletionBusy ? t('pages.publicProjects.deleting') : t('pages.publicProjects.deletePermanently') }}
          </button>
        </footer>
      </div>
    </dialog>
  </section>
</template>
