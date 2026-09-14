<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'

import { deleteJson, getJson, postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { useModalDialog } from '@/composables/useModalDialog'
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

const FULI_WORKSPACE_PROTOCOL = 'fuli-workspace-v1'

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
let detailRequestVersion = 0
let detailController: AbortController | null = null

const projects = computed(() => store.state?.projects ?? [])
const workspaces = computed(() => store.state?.providers?.workspaces ?? [])
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
const relationProjects = computed(() =>
  maintainable.value.filter(({ providerUrl }) => supportsGraphitiProjectOperations(providerUrl)),
)
const maintainableOptions = computed(() =>
  relationProjects.value.map((project) => ({
    value: project.id,
    label: project.name,
    meta: `#${compactIdentity(project.id, 26)}`,
    search: identitySearchText(project.id),
  })),
)
const relationTargets = computed(() => {
  const source = projects.value.find(({ id }) => id === relationSource.value)
  if (!source || !supportsGraphitiProjectOperations(source.providerUrl)) return []
  return projects.value.filter(
    ({ id, providerUrl }) => id !== source.id
      && providerUrl === source.providerUrl
      && supportsGraphitiProjectOperations(providerUrl),
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
const selectedProjectSupportsDetails = computed(() =>
  selectedProject.value
    ? supportsGraphitiProjectOperations(selectedProject.value.providerUrl)
    : false,
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

const {
  dialogRef: detailsDialogRef,
  initialFocusRef: detailsInitialFocusRef,
  onCancel: onDetailsCancel,
  onKeydown: onDetailsKeydown,
} = useModalDialog(
  () => Boolean(selectedProject.value),
  closeDetails,
)
const {
  dialogRef: deletionDialogRef,
  initialFocusRef: deletionInitialFocusRef,
  onCancel: onDeletionCancel,
  onKeydown: onDeletionKeydown,
} = useModalDialog(
  () => Boolean(deletionProject.value),
  closeProjectDeletion,
)

function projectKey(project: PublicProject) {
  return `${project.providerUrl}::${project.id}`
}

function supportsGraphitiProjectOperations(providerUrl: string) {
  const workspace = workspaces.value.find(({ providerUrl: configuredUrl }) =>
    configuredUrl === providerUrl)
  return workspace?.protocol !== FULI_WORKSPACE_PROTOCOL
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
  closeDetails()
  selectedProject.value = project
  releases.value = []
  relations.value = []
  if (!supportsGraphitiProjectOperations(project.providerUrl)) return

  const requestVersion = ++detailRequestVersion
  const controller = new AbortController()
  detailController = controller
  detailLoading.value = true
  try {
    const provider = new URLSearchParams({ providerUrl: project.providerUrl })
    const [releaseResult, relationResult] = await Promise.all([
      getJson<{ releases?: ProjectRelease[] }>(
        `/api/projects/${encodeURIComponent(project.id)}/releases?${provider}`,
        { signal: controller.signal },
      ),
      getJson<{ relations?: ProjectRelation[] }>(
        `/api/project-relations?${new URLSearchParams({
          projectId: project.id,
          providerUrl: project.providerUrl,
        })}`,
        { signal: controller.signal },
      ),
    ])
    if (requestVersion !== detailRequestVersion || controller.signal.aborted) return
    releases.value = releaseResult.releases ?? []
    relations.value = relationResult.relations ?? []
  } catch (error) {
    if (requestVersion !== detailRequestVersion || controller.signal.aborted) return
    store.reportError(error)
  } finally {
    if (requestVersion !== detailRequestVersion || controller.signal.aborted) return
    detailLoading.value = false
    if (detailController === controller) detailController = null
  }
}

async function openGraph(project: PublicProject) {
  closeDetails()
  await router.push(knowledgePath('public', project.id, 'graph'))
}

function cancelDetailRequest() {
  detailRequestVersion += 1
  detailController?.abort()
  detailController = null
  detailLoading.value = false
}

function closeDetails() {
  cancelDetailRequest()
  selectedProject.value = null
  releases.value = []
  relations.value = []
}

function openProjectDeletion(project: PublicProject) {
  if (!supportsGraphitiProjectOperations(project.providerUrl)) return
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
  if (!supportsGraphitiProjectOperations(project.providerUrl)) {
    deletionError.value = t('pages.publicProjects.providerOperationsUnavailable')
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
  if (!supportsGraphitiProjectOperations(source.providerUrl)) {
    store.reportError(new Error(t('pages.publicProjects.providerOperationsUnavailable')))
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

onBeforeUnmount(cancelDetailRequest)

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
          <div><h4>{{ project.name }}</h4></div>
          <div class="project-card-heading-actions">
            <button
              v-if="project.can_manage && supportsGraphitiProjectOperations(project.providerUrl)"
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
          <span
            v-if="project.current_release && supportsGraphitiProjectOperations(project.providerUrl)"
            class="project-release-meta"
          >
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
        <div><h3>{{ t('pages.publicProjects.relationsTitle') }}</h3><p>{{ t('pages.publicProjects.relationsCopy') }}</p></div>
        <button class="primary-action" type="button" :disabled="!relationProjects.length" @click="relationOpen = !relationOpen">
          {{ t('pages.publicProjects.addRelation') }}
        </button>
      </div>
      <p v-if="maintainable.length && !relationProjects.length" class="muted">
        {{ t('pages.publicProjects.providerOperationsUnavailable') }}
      </p>
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

    <dialog
      ref="detailsDialogRef"
      class="project-dialog vue-dialog"
      aria-modal="true"
      aria-labelledby="public-project-details-title"
      @cancel="onDetailsCancel"
      @keydown="onDetailsKeydown"
    >
      <div v-if="selectedProject" class="project-dialog-shell">
        <header class="project-dialog-header">
          <div><h3 id="public-project-details-title">{{ selectedProject.name }}</h3><p>{{ projectPurpose(selectedProject) }}</p></div>
          <button ref="detailsInitialFocusRef" class="secondary-action" type="button" @click="closeDetails">{{ t('common.actions.close') }}</button>
        </header>
        <template v-if="selectedProjectSupportsDetails">
          <section class="project-latest-release">

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
              <GrowthLoading v-if="detailLoading" variant="compact" :label="t('pages.publicProjects.loading')" />
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
        </template>
        <section v-else class="project-latest-release">
          <p class="muted">{{ t('pages.publicProjects.providerOperationsUnavailableTitle') }}</p>
        </section>
        <footer class="project-dialog-actions">
          <span>{{ t('pages.publicProjects.contentManagementSeparated') }}</span>
          <button class="primary-action" type="button" @click="openGraph(selectedProject)">{{ t('pages.publicProjects.viewGraph') }}</button>
        </footer>
      </div>
    </dialog>

    <dialog
      ref="deletionDialogRef"
      class="project-dialog vue-dialog"
      aria-modal="true"
      aria-labelledby="public-project-deletion-title"
      @cancel="onDeletionCancel"
      @keydown="onDeletionKeydown"
    >
      <div v-if="deletionProject" class="project-dialog-shell">
        <header class="project-dialog-header">
          <div>

            <h3 id="public-project-deletion-title">{{ t('pages.publicProjects.deleteTitle') }}</h3>
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
            ref="deletionInitialFocusRef"
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
            <GrowthLoading v-if="deletionBusy" variant="inline" :label="t('pages.publicProjects.deleting')" />
            <span v-else>{{ t('pages.publicProjects.deletePermanently') }}</span>
          </button>
        </footer>
      </div>
    </dialog>
  </section>
</template>
