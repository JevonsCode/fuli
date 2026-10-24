<script setup lang="ts">
import PublishQueue from '@/features/publishing/PublishQueue.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { deleteJson, getJson, postJson } from '@/api/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { focusReturnTarget } from '@/composables/useFocusReturn'
import { useRoutePeek } from '@/composables/useRoutePeek'
import UiDialog from '@/ui/UiDialog.vue'
import UiSelect from '@/ui/UiSelect.vue'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_FULL, formatDateTime } from '@/lib/date-time'
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
// Details are a quick look (Peek) in the URL: ?item=<provider>/<project>.
const peek = useRoutePeek()
const selectedProject = computed(() => {
  const item = peek.item.value
  return item ? projects.value.find(({ providerUrl, id }) => providerUrl === item.spaceId && id === item.id) ?? null : null
})
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

// Focus goes back to the card button that opened the details, or to the card after a link.
const scroller = ref<HTMLElement | null>(null)
let detailsOpener: HTMLElement | null = null
let lastDetailsKey = ''
function openDetails(project: PublicProject) {
  const active = document.activeElement
  detailsOpener = active instanceof HTMLElement && active !== document.body ? active : null
  peek.open({ spaceId: project.providerUrl, id: project.id })
}
function detailsOpenChange(open: boolean) { if (!open) peek.close() }
function returnFocusFromDetails(event: Event) {
  event.preventDefault()
  const opener = detailsOpener
  detailsOpener = null
  if (opener?.isConnected) opener.focus({ preventScroll: true })
  else focusReturnTarget(scroller.value, lastDetailsKey)
}
watch(() => selectedProject.value && projectKey(selectedProject.value), (key) => {
  clearDetails()
  if (!key || !selectedProject.value) return
  lastDetailsKey = key
  void loadDetails(selectedProject.value)
}, { immediate: true })

async function loadDetails(project: PublicProject) {
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

// The graph replaces the details in history, so Back returns to the collection.
async function openGraph(project: PublicProject) {
  clearDetails()
  await router.replace(knowledgePath('public', project.id, 'graph'))
}

function cancelDetailRequest() {
  detailRequestVersion += 1
  detailController?.abort()
  detailController = null
  detailLoading.value = false
}

function clearDetails() {
  cancelDetailRequest()
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
    if (selectedProject.value && projectKey(selectedProject.value) === projectKey(project)) peek.close()
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
  return formatDateTime(value, currentLocale(), DATE_TIME_FULL, { missing: t('pages.publicProjects.timeNotRecorded') })
}
</script>

<template>
  <section ref="scroller" class="view public-projects-view">
    <div class="@container mx-auto flex w-full max-w-(--layout-max) flex-col gap-4">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
        <p class="page-lede m-0 text-sm text-muted-foreground">{{ t('pages.publicProjects.intro') }}</p>
        <p class="public-space-stats m-0 ml-auto flex gap-4 text-sm text-muted-foreground" :aria-label="t('pages.publicProjects.overviewAria')">
          <span><strong class="mr-1 text-foreground">{{ projects.length }}</strong>{{ t('pages.publicProjects.discoverable') }}</span>
          <span><strong class="mr-1 text-foreground">{{ store.state?.subscriptions.length ?? 0 }}</strong>{{ t('pages.publicProjects.subscribedCount') }}</span>
        </p>
      </div>

      <PublishQueue />

      <ul v-if="projects.length" class="m-0 grid list-none grid-cols-1 gap-3 p-0 @min-[620px]:grid-cols-2 @min-[960px]:grid-cols-3 @min-[1400px]:grid-cols-4">
        <li v-for="project in projects" :key="projectKey(project)" class="min-w-0">
          <article class="project-card flex h-full min-w-0 flex-col gap-3 rounded-lg border bg-card p-4 transition-[border-color,box-shadow] hover:border-border-strong"
            :class="{ 'is-selected border-border-strong shadow-md': selectedProject && projectKey(selectedProject) === projectKey(project) }"
            :data-return-focus="projectKey(project)">
            <header class="flex min-w-0 items-start gap-3">
              <h2 class="m-0 min-w-0 flex-1 text-base leading-snug font-semibold [overflow-wrap:anywhere]">{{ project.name }}</h2>
              <span class="project-coverage grid shrink-0 justify-items-end text-xs text-muted-foreground">
                <strong class="text-lg leading-none text-foreground">{{ project.profile?.assessment?.score ?? '—' }}</strong>
                {{ project.profile?.assessment ? t('pages.publicProjects.coverage') : t('pages.publicProjects.noSummary') }}
              </span>
            </header>
            <p class="project-purpose m-0 line-clamp-3 text-sm text-muted-foreground" :title="projectPurpose(project)">{{ projectPurpose(project) }}</p>
            <div class="flex min-w-0 flex-wrap gap-1.5">
              <Badge v-for="(source, index) in project.profile?.sources ?? []" :key="index" variant="outline">{{ source.kind ?? t('pages.publicProjects.material') }}</Badge>
              <span v-if="!project.profile?.sources?.length" class="text-xs text-muted-foreground">{{ t('pages.publicProjects.noSources') }}</span>
            </div>
            <div class="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
              <Badge :variant="project.isOwner ? 'success' : 'secondary'">{{ project.isOwner ? 'Owner' : project.role ?? 'Reader' }}</Badge>
              <span>{{ project.isOwner ? t('pages.publicProjects.publishedByYou') : t('pages.publicProjects.publiclyDiscoverable') }}</span>
              <span v-if="project.current_release && supportsGraphitiProjectOperations(project.providerUrl)" class="project-release-meta ml-auto">
                <strong class="text-foreground">{{ project.current_release.version }}</strong> · {{ formatDate(project.current_release.published_at) }}
              </span>
            </div>
            <footer class="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" data-project-subscription @click="toggleSubscription(project)">
                {{ subscribedKeys.has(projectKey(project)) ? t('pages.publicProjects.unsubscribe') : t('pages.publicProjects.subscribe') }}
              </Button>
              <Button v-if="project.can_manage && supportsGraphitiProjectOperations(project.providerUrl)" variant="ghost" size="sm"
                class="project-manage-action" @click="openProjectDeletion(project)">{{ t('pages.publicProjects.manage') }}</Button>
              <Button size="sm" class="ml-auto" data-project-details aria-haspopup="dialog" @click="openDetails(project)">{{ t('common.actions.viewDetails') }}</Button>
            </footer>
          </article>
        </li>
      </ul>
      <p v-else class="project-empty m-0 rounded-lg border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">{{ t('pages.publicProjects.noProjects') }}</p>

      <Card as="section" class="project-relations-card" aria-labelledby="public-project-relations-title">
        <div class="flex flex-wrap items-center justify-between gap-3 px-5">
          <CardTitle id="public-project-relations-title" as="h2" class="text-base">{{ t('pages.publicProjects.relationsTitle') }}</CardTitle>
            <Button size="sm" data-add-relation :disabled="!relationProjects.length" :aria-expanded="relationOpen" @click="relationOpen = !relationOpen">
              {{ t('pages.publicProjects.addRelation') }}
            </Button>
        </div>
        <p v-if="maintainable.length && !relationProjects.length" class="m-0 px-5 text-sm text-muted-foreground">
          {{ t('pages.publicProjects.providerOperationsUnavailable') }}
        </p>
        <form v-if="relationOpen" class="compact-relation-form grid items-end gap-3 px-5 @min-[720px]:grid-cols-3" @submit.prevent="createRelation">
          <label class="grid min-w-0 gap-1 text-xs text-muted-foreground">{{ t('pages.publicProjects.sourceProject') }}
            <UiSelect
              v-model="relationSource"
              :options="maintainableOptions"
              :label="t('pages.publicProjects.sourceProjectLabel')"
              :placeholder="t('pages.publicProjects.chooseProject')"
              searchable
              required
              @change="relationTarget = ''"
            />
          </label>
          <label class="grid min-w-0 gap-1 text-xs text-muted-foreground">{{ t('pages.publicProjects.relation') }}
            <UiSelect
              v-model="relationType"
              :options="relationTypeOptions"
              :label="t('pages.publicProjects.relationTypeLabel')"
            />
          </label>
          <label class="grid min-w-0 gap-1 text-xs text-muted-foreground">{{ t('pages.publicProjects.targetProject') }}
            <UiSelect
              v-model="relationTarget"
              :options="relationTargetOptions"
              :label="t('pages.publicProjects.targetProjectLabel')"
              :placeholder="t('pages.publicProjects.chooseProject')"
              searchable
              required
            />
          </label>
          <div class="compact-relation-preview grid gap-1 rounded-md border bg-secondary px-3 py-2.5 text-xs @min-[720px]:col-span-3" aria-live="polite">
            <span class="font-semibold text-muted-foreground">{{ t('pages.publicProjects.preview') }}</span>
            <strong>
              {{ relationSourceProject?.name || t('pages.publicProjects.sourceProject') }}
              {{ relationTypeLabel }}
              {{ relationTargetProject?.name || t('pages.publicProjects.targetProject') }}
            </strong>
            <p v-if="relationType === 'PART_OF'" class="m-0 text-muted-foreground">
              {{ t('pages.publicProjects.parentConfirmation') }}
            </p>
            <p v-else class="m-0 text-muted-foreground">{{ t('pages.publicProjects.relationBoundary') }}</p>
          </div>
          <Button size="sm" type="submit" class="justify-self-start">{{ t('pages.publicProjects.addRelation') }}</Button>
        </form>
      </Card>
    </div>

    <Dialog :open="Boolean(peek.item.value)" @update:open="detailsOpenChange">
      <DialogContent size="lg" class="public-project-details" data-public-project-peek @close-auto-focus="returnFocusFromDetails">
        <template v-if="selectedProject">
          <DialogHeader>
            <DialogTitle class="text-xl leading-tight [overflow-wrap:anywhere]">{{ selectedProject.name }}</DialogTitle>
            <DialogDescription>{{ projectPurpose(selectedProject) }}</DialogDescription>
          </DialogHeader>
          <template v-if="selectedProjectSupportsDetails">
            <section class="grid gap-1">
              <h3 class="m-0 text-sm font-semibold">{{ t('pages.publicProjects.latestRelease') }}</h3>
              <p v-if="selectedProject.current_release" class="m-0 text-sm">
                <strong>{{ selectedProject.current_release.version }}</strong>
                · {{ formatDate(selectedProject.current_release.published_at) }}
              </p>
              <p v-else class="m-0 text-sm text-muted-foreground">{{ t('pages.publicProjects.noRelease') }}</p>
            </section>
            <div class="project-detail-columns grid gap-6 sm:grid-cols-2">
              <section class="grid content-start gap-2">
                <h3 class="m-0 text-sm font-semibold">{{ t('pages.publicProjects.releaseHistory') }}</h3>
                <GrowthLoading v-if="detailLoading" variant="compact" :label="t('pages.publicProjects.loading')" />
                <article v-for="release in releases" :key="release.version" class="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 border-t pt-2 text-xs">
                  <strong class="row-span-2">{{ release.version }}</strong>
                  <p class="m-0 text-muted-foreground">{{ release.update_summary }}</p>
                  <small class="text-muted-foreground">{{ formatDate(release.published_at) }}</small>
                </article>
                <p v-if="!detailLoading && !releases.length" class="m-0 text-sm text-muted-foreground">{{ t('pages.publicProjects.noReleaseHistory') }}</p>
              </section>
              <section class="grid content-start gap-2">
                <h3 class="m-0 text-sm font-semibold">{{ t('pages.publicProjects.relationsTitle') }}</h3>
                <article v-for="relation in relations" :key="relation.id" class="flex justify-between gap-3 border-t pt-2 text-xs">
                  <strong>{{ relation.relation_type }}</strong><small class="text-muted-foreground">{{ relation.status ?? 'active' }}</small>
                </article>
                <p v-if="!detailLoading && !relations.length" class="m-0 text-sm text-muted-foreground">{{ t('pages.publicProjects.noRelations') }}</p>
              </section>
            </div>
          </template>
          <p v-else class="m-0 text-sm text-muted-foreground">{{ t('pages.publicProjects.providerOperationsUnavailableTitle') }}</p>
          <DialogFooter class="flex flex-wrap items-center gap-3 border-t pt-4">
            <span class="mr-auto text-xs text-muted-foreground">{{ t('pages.publicProjects.contentManagementSeparated') }}</span>
            <Button data-open-graph @click="openGraph(selectedProject)">{{ t('pages.publicProjects.viewGraph') }}</Button>
          </DialogFooter>
        </template>
        <template v-else>
          <DialogHeader>
            <DialogTitle>{{ t('common.actions.viewDetails') }}</DialogTitle>
            <DialogDescription :class="{ 'sr-only': !store.state }">{{ t(store.state ? 'pages.publicProjects.unavailable' : 'common.status.loadingConsole') }}</DialogDescription>
          </DialogHeader>
          <GrowthLoading v-if="!store.state" variant="compact" :label="t('common.status.loadingConsole')" />
        </template>
      </DialogContent>
    </Dialog>

    <UiDialog v-if="deletionProject" open class="public-project-deletion" size="sm" :busy="deletionBusy" :error="deletionError"
      :title="t('pages.publicProjects.deleteTitle')" :description="t('pages.publicProjects.deleteCopy')" @close="closeProjectDeletion">
      <label class="ui-field">
        <span>{{ t('pages.publicProjects.enterFullName') }} <strong>{{ deletionProject.name }}</strong></span>
        <input v-model="deletionName" autocomplete="off" :disabled="deletionBusy" />
      </label>
      <template #footer>
        <span class="mr-auto text-xs text-muted-foreground">{{ t('pages.publicProjects.deleteWarning') }}</span>
        <Button variant="destructive" :disabled="!deletionMatches" :loading="deletionBusy" :loading-label="t('pages.publicProjects.deleting')" @click="deleteProject">{{ t('pages.publicProjects.deletePermanently') }}</Button>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.public-projects-view { scrollbar-gutter: stable; }
</style>
