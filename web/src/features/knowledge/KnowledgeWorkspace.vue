<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import UiSelect from '@/ui/UiSelect.vue'
import { UiToggle } from '@/ui'
import { filterListedProjectGraph, isListedProject } from '@/features/projects/project-list-visibility'
import {
  isLoadingPreviewEnabled,
  useMinimumLoadingDisplay,
} from '@/composables/useMinimumLoadingDisplay'
import { t } from '@/i18n'
import { createDebouncedAction } from '@/lib/debounce'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { knowledgePath, personalProjectsPath, type KnowledgeMode, type KnowledgeScope } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'
import type {
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeItem,
  KnowledgeNode,
  PersonalProject,
  PublicProject,
} from '@/types'
import GraphCanvas from './GraphCanvas.vue'
import GraphRelationLegend from './GraphRelationLegend.vue'
import GraphSearchStatus from './GraphSearchStatus.vue'
import KnowledgeDirectoryPanel from './KnowledgeDirectoryPanel.vue'
import KnowledgePeek from './KnowledgePeek.vue'
import { reconcileKnowledgeWrites } from './knowledge-write-lifecycle'
import KnowledgeWorkspaceDialogs from './KnowledgeWorkspaceDialogs.vue'
import ProjectHierarchyAside from './ProjectHierarchyAside.vue'
import ProjectOverview from '@/features/projects/ProjectOverview.vue'
import { pickerOrder, projectDisplayName } from '@/features/projects/project-origin'
import CreateProjectEntry from '@/features/projects/CreateProjectEntry.vue'
import ProjectDropPanel from '@/features/projects/ProjectDropPanel.vue'
import { useProjectOrganize } from '@/features/projects/useProjectOrganize'
import {
  currentKnowledgeGraph,
  filterKnowledgeItems,
  isManagementKnowledgeItem,
  knowledgeItemFromEdge,
  knowledgeItemFromNode,
  knowledgeItems,
  managementKnowledgeItems,
  mergeKnowledgeGraphs,
  personalProjectIdForItem,
  projectMaterialTypeLabel,
  quadrantLabel,
  knowledgeItemKey,
} from './model'
import {
   discoverPersonalProjectResults,
  type KnowledgeSearchResult,
  type PersonalProjectDiscovery,
} from './project-discovery'
import { separateParentProjects } from './project-hierarchy'
import {
  extractFrequentProjects,
  filterFormalProjectGraph,
} from './project-relation-weights'

const props = withDefaults(defineProps<{
  personalProjectsOnly?: boolean
}>(), {
  personalProjectsOnly: false,
})

type GraphCanvasApi = InstanceType<typeof GraphCanvas>
type DirectorySection = 'knowledge' | 'materials'
type SpaceChoice = {
  key: string
  scope: KnowledgeScope
  spaceId: string
  projectId: string | null
  providerUrl: string | null
  label: string
}

const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const loading = ref(false)
const showTemporaryProjects = ref(false)
const graph = ref<KnowledgeGraph | null>(null)
const loadingPreview = isLoadingPreviewEnabled()
const initialLoading = computed(() => loadingPreview || (loading.value && !graph.value))
const showInitialLoading = useMinimumLoadingDisplay(initialLoading)
const selectedItem = ref<KnowledgeItem | null>(null)
const graphCanvas = ref<GraphCanvasApi | null>(null)
const searchDraft = ref(queryValue(route.query.q))
const searchMessage = ref('')
const searching = ref(false)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const projectActionItem = ref<KnowledgeItem | null>(null)
const publishingProject = ref<PersonalProject | null>(null)
const managingProject = ref<PersonalProject | null>(null)
const managingMaterialType = ref<string | null>(null)
const projectDiscovery = ref<{
  query: string
  checking: boolean
  result: PersonalProjectDiscovery | null
} | null>(null)
const pendingRouteSearchQueries = new Set<string>()
let loadSequence = 0
let searchSequence = 0
let searchAbortController: AbortController | null = null
let loadedGraphContextKey: string | null = null
// True while the item in the URL is the entry this page pushed (see closePeek).
let peekPushed = false

const scope = computed<KnowledgeScope>(() => {
  if (props.personalProjectsOnly) return 'personal'
  return route.params.scope === 'public' ? 'public' : 'personal'
})
const spaceId = computed(() => String(route.params.spaceId ?? store.activePersonalSpace?.id ?? ''))
const projectId = computed(() => {
  const value = route.params.projectId
  return typeof value === 'string' && value ? value : null
})
const overviewAvailable = computed(() => props.personalProjectsOnly && Boolean(projectId.value))
const mode = computed<KnowledgeMode>(() => {
  if (route.params.mode === 'graph') return 'graph'
  if (route.params.mode === 'overview' && overviewAvailable.value) return 'overview'
  return 'directory'
})
const contextIds = computed(() => queryValues(route.query.context))
const graphContextKey = computed(() => JSON.stringify([
  props.personalProjectsOnly,
  scope.value,
  spaceId.value,
  projectId.value,
  contextIds.value,
]))
const projectListingOptions = computed(() => ({
  showTemporary: showTemporaryProjects.value,
  selectedProjectId: projectId.value,
}))
const listedGraph = computed(() => graph.value && props.personalProjectsOnly
  ? filterListedProjectGraph(graph.value, personalProjects.value, projectListingOptions.value)
  : graph.value)
const allItems = computed(() => knowledgeItems(listedGraph.value))
const projectMaterialItems = computed(() =>
  props.personalProjectsOnly ? managementKnowledgeItems(listedGraph.value) : [],
)
const visibleProjectMaterialItems = computed(() => {
  const query = searchDraft.value.trim().toLocaleLowerCase()
  if (!query) return projectMaterialItems.value
  return projectMaterialItems.value.filter((item) =>
    [
      item.title,
      item.body,
      item.type,
      projectMaterialTypeLabel(item),
    ].some((value) => value.toLocaleLowerCase().includes(query)),
  )
})
const selectableItems = computed(() => [
  ...(props.personalProjectsOnly ? managementKnowledgeItems(graph.value) : []),
  ...knowledgeItems(graph.value),
])
const directorySection = computed<DirectorySection>(() => {
  if (!props.personalProjectsOnly) return 'knowledge'
  if (mode.value === 'directory' && selectedItem.value) {
    return isManagementKnowledgeItem(selectedItem.value) ? 'materials' : 'knowledge'
  }
  return queryValue(route.query.section) === 'materials' ? 'materials' : 'knowledge'
})
const typeOptions = computed(() => [...new Set(allItems.value.map(({ type }) => type))].sort())
const typeSelectOptions = computed(() => [
  { value: 'all', label: t('knowledge.workspace.workspace.filters.allTypes') },
  ...typeOptions.value.map((type) => ({ value: type, label: type })),
])
const quadrantSelectOptions = computed(() => [
  { value: 'all', label: t('knowledge.workspace.workspace.filters.allQuadrants') },
  ...['known_known', 'known_unknown', 'unknown_known', 'unknown_unknown']
    .map((value) => ({ value, label: quadrantLabel(value) })),
])
const profileSelectOptions = computed(() => [
  { value: 'all', label: t('knowledge.workspace.workspace.filters.allKnowledge') },
  { value: 'profile', label: t('knowledge.workspace.workspace.filters.preferences') },
  { value: 'regular', label: t('knowledge.workspace.workspace.filters.projectKnowledge') },
])
const humanChangeSelectOptions = computed(() => [
  { value: 'all', label: t('knowledge.workspace.workspace.filters.allHumanStates') },
  {
    value: 'human_changed',
    label: t('knowledge.workspace.workspace.filters.allHumanChanged'),
  },
  { value: 'unseen', label: t('knowledge.workspace.workspace.filters.agentUnseen') },
  { value: 'viewed', label: t('knowledge.workspace.workspace.filters.viewedPending') },
  { value: 'reviewed', label: t('knowledge.workspace.workspace.filters.agentReviewed') },
])
const contentStatus = computed<'current' | 'historical' | 'all'>(() => {
  const value = queryValue(route.query.status)
  return value === 'historical' || value === 'all' ? value : 'current'
})
const filters = computed(() => ({
  query: searchDraft.value,
  type: queryValue(route.query.type) || 'all',
  quadrant: queryValue(route.query.quadrant) || 'all',
  profile: queryValue(route.query.profile) || 'all',
  status: contentStatus.value,
  humanChange: queryValue(route.query.human) || 'all',
}))
const directoryListResetKey = computed(() => JSON.stringify([
  directorySection.value,
  filters.value,
]))
const visibleItems = computed(() => filterKnowledgeItems(allItems.value, filters.value))
const currentItemCount = computed(() => allItems.value.filter(({ invalidAt }) => !invalidAt).length)
const historicalItemCount = computed(() => allItems.value.length - currentItemCount.value)
const selectedStatusTotal = computed(() => {
  if (contentStatus.value === 'current') return currentItemCount.value
  if (contentStatus.value === 'historical') return historicalItemCount.value
  return allItems.value.length
})
const selectedStatusLabel = computed(() => {
  if (contentStatus.value === 'current') return t('common.status.current')
  if (contentStatus.value === 'historical') return t('common.status.invalid')
  return t('knowledge.workspace.workspace.status.all')
})
const currentGraphView = computed(() =>
  listedGraph.value
    ? props.personalProjectsOnly
      ? currentKnowledgeGraph(listedGraph.value)
      : filterFormalProjectGraph(currentKnowledgeGraph(listedGraph.value), personalProjects.value)
    : null,
)
const activeFrequentProjects = computed(() =>
  extractFrequentProjects(graph.value, projectId.value, personalProjects.value),
)
const projectHierarchy = computed(() =>
  currentGraphView.value
    ? separateParentProjects(currentGraphView.value, projectId.value)
    : null,
)
const graphView = computed(() => projectHierarchy.value?.graph ?? null)
const parentProjects = computed(() => projectHierarchy.value?.parents ?? [])
// 调整层级 works on the all-projects graph, where every project is on the canvas.
const organizeAvailable = computed(() =>
  props.personalProjectsOnly && !projectId.value && mode.value === 'graph',
)
const organize = reactive(useProjectOrganize({ graph: graphView, spaceId, canvas: graphCanvas, onMoved: () => loadGraph() }))
const graphRelationTypes = computed(() =>
  graphView.value?.edges.map(({ type }) => type) ?? [],
)
const countLabel = computed(() => {
  if (!graph.value) {
    return loading.value
      ? t('common.status.loadingKnowledge')
      : t('knowledge.workspace.workspace.status.graphUnread')
  }
  if (mode.value === 'graph') {
    const value = graphView.value
    return searchMessage.value || t('knowledge.workspace.workspace.counts.graph', {
      nodes: value?.nodes.length ?? 0,
      edges: value?.edges.length ?? 0,
    })
  }
  if (directorySection.value === 'materials') {
    return visibleProjectMaterialItems.value.length === projectMaterialItems.value.length
      ? t('knowledge.workspace.workspace.counts.materials', {
          count: projectMaterialItems.value.length,
        })
      : t('knowledge.workspace.workspace.counts.visibleMaterials', {
          visible: visibleProjectMaterialItems.value.length,
          total: projectMaterialItems.value.length,
        })
  }
  const knowledgeCount = visibleItems.value.length === selectedStatusTotal.value
    ? t('knowledge.workspace.workspace.counts.knowledge', {
        status: selectedStatusLabel.value,
        count: selectedStatusTotal.value,
      })
    : t('knowledge.workspace.workspace.counts.visibleKnowledge', {
        status: selectedStatusLabel.value,
        visible: visibleItems.value.length,
        total: selectedStatusTotal.value,
      })
  return knowledgeCount
})
const knowledgeTabCount = computed(() => String(allItems.value.length))
const materialTabCount = computed(() => String(projectMaterialItems.value.length))
const personalProjects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    ({ personal_space_id }) => personal_space_id === spaceId.value,
  ),
)
const availableContexts = computed(() =>
  personalProjects.value.filter(project => project.project_id !== projectId.value
    && (!props.personalProjectsOnly || isListedProject(project, projectListingOptions.value))),
)
const spaceChoices = computed<SpaceChoice[]>(() => {
  const state = store.state
  if (!state) return []
  const personal = state.personalSpaces.flatMap((space) => {
    const aggregate: SpaceChoice = {
      key: choiceKey('personal', space.id, null),
      scope: 'personal',
      spaceId: space.id,
      projectId: null,
      providerUrl: null,
      label: t('knowledge.workspace.workspace.spaces.allPersonalProjects', {
        name: space.name,
      }),
    }
    const projects = pickerOrder((state.personalProjects ?? [])
      .filter(project => project.personal_space_id === space.id
        && (!props.personalProjectsOnly || isListedProject(project, {
          ...projectListingOptions.value,
          selectedProjectId: space.id === spaceId.value ? projectId.value : null,
        }))))
      .map((project): SpaceChoice => ({
        key: choiceKey('personal', space.id, project.project_id),
        scope: 'personal',
        spaceId: space.id,
        projectId: project.project_id,
        providerUrl: null,
        label: t('knowledge.workspace.workspace.spaces.personalProject', {
          name: projectDisplayName(project),
        }),
      }))
    return [aggregate, ...projects]
  })
  if (props.personalProjectsOnly) return personal
  const publicProjects = state.projects.map((project): SpaceChoice => ({
    key: choiceKey('public', project.id, null),
    scope: 'public',
    spaceId: project.id,
    projectId: null,
    providerUrl: project.providerUrl,
    label: t('knowledge.workspace.workspace.spaces.publicProject', {
      name: project.name,
    }),
  }))
  return [...personal, ...publicProjects]
})
const selectedChoiceKey = computed(() => choiceKey(scope.value, spaceId.value, projectId.value))
const spaceSelectOptions = computed(() =>
  spaceChoices.value.map((choice) => {
    const identity = choice.projectId ?? choice.spaceId
    return {
      value: choice.key,
      label: choice.label,
      meta: `#${compactIdentity(identity, 26)}`,
      search: identitySearchText(identity),
    }
  }),
)
const editable = computed(() => scope.value === 'personal')
const activePersonalProject = computed(() =>
  personalProjects.value.find(({ project_id }) => project_id === projectId.value) ?? null,
)
// A form opened from the quick look takes its place until it closes.
const peekSuspended = computed(() => Boolean(
  editingItem.value || confirmingItem.value || projectActionItem.value
  || publishingProject.value || managingProject.value,
))
const manageableSelectedProject = computed(() =>
  projectForMaterial(selectedItem.value),
)

const searchDebounce = createDebouncedAction(() => {
  void applySearchDraft()
}, 300)

watch(
  [
    () => store.state,
    () => route.name,
    () => route.params.mode,
    () => route.params.spaceId,
  ],
  async ([state]) => {
    if (!state) return
    await normalizeRoute()
  },
  { immediate: true },
)

watch(
  [() => store.state, graphContextKey],
  async ([state]) => {
    if (!state) return
    await loadGraph()
  },
  { immediate: true },
)

watch(
  () => queryValue(route.query.q),
  (query) => {
    if (query === searchDraft.value || pendingRouteSearchQueries.has(query)) return
    searchDebounce.cancel()
    cancelGraphSearch()
    searchDraft.value = query
    resetGraphSearchState()
    if (
      mode.value === 'graph'
      && query.trim()
      && graph.value
      && !loading.value
      && loadedGraphContextKey === graphContextKey.value
    ) {
      void runGraphSearch(query.trim())
    }
  },
  { flush: 'sync' },
)

watch(mode, async () => {
  searchDebounce.cancel()
  cancelGraphSearch()
  resetGraphSearchState()
  await nextTick()
  selectDeepLinkedItem()
  void applySearchDraft()
})

watch(
  [() => route.params.itemKind, () => route.params.itemId],
  ([, itemId]) => {
    if (!itemId) peekPushed = false
    selectDeepLinkedItem()
  },
)

onBeforeUnmount(() => {
  searchDebounce.cancel()
  cancelGraphSearch()
})

async function normalizeRoute() {
  const activeSpace = store.activePersonalSpace
  if (!activeSpace) return
  if (route.name === 'knowledge-default') {
    await router.replace(knowledgePath('personal', activeSpace.id, 'directory'))
    return
  }
  if (spaceId.value === 'current') {
    const path = props.personalProjectsOnly
      ? personalProjectsPath(activeSpace.id, mode.value, projectId.value)
      : knowledgePath(scope.value, activeSpace.id, mode.value, { projectId: projectId.value })
    await router.replace({ path, query: route.query })
    return
  }
  const validMode = route.params.mode === 'directory' || route.params.mode === 'graph'
    || (route.params.mode === 'overview' && overviewAvailable.value)
  if (!validMode) {
    await changeMode(props.personalProjectsOnly ? 'graph' : 'directory', true)
  }
}

// A project's own profile entity opened from the all-projects list is the
// project itself: show its overview. The ID comes from the Provider's entity
// attributes and must belong to an authorized project in this space.
function overviewProjectFor(item: KnowledgeItem | null) {
  if (!props.personalProjectsOnly || projectId.value || mode.value !== 'directory') return null
  if (!item || item.itemKind !== 'entity' || item.type !== 'PersonalProject') return null
  const id = personalProjectIdForItem(item)
  return personalProjects.value.some(({ project_id }) => project_id === id) ? id : null
}

async function openProjectOverview(nextProjectId: string, replace: boolean) {
  await router[replace ? 'replace' : 'push'](personalProjectsPath(spaceId.value, 'overview', nextProjectId))
}

function revokeKnowledgeAccess() {
  ++loadSequence
  cancelGraphSearch()
  graph.value = null
  loadedGraphContextKey = null
  selectedItem.value = null
  editingItem.value = null
  confirmingItem.value = null
  projectActionItem.value = null
  publishingProject.value = null
  managingProject.value = null
  loading.value = false
  resetGraphSearchState()
  store.reportError(new Error(t('preferences.detail.accessDenied')))
}

async function loadGraph() {
  if (!spaceId.value || spaceId.value === 'current') return
  const contextKey = graphContextKey.value
  const sequence = ++loadSequence
  cancelGraphSearch()
  loading.value = true
  editingItem.value = null
  confirmingItem.value = null
  selectedItem.value = null
  resetGraphSearchState()
  try {
    const value = projectId.value && scope.value === 'personal'
      ? await loadPersonalProjectContext()
      : await readGraph(projectId.value)
    if (sequence !== loadSequence) return
    reconcileKnowledgeWrites(store.activePersonalSpace?.id ?? spaceId.value, knowledgeItems(value))
    graph.value = value
    loadedGraphContextKey = contextKey
    selectDeepLinkedItem()
    if (mode.value === 'graph' && searchDraft.value.trim()) {
      await nextTick()
      void runGraphSearch(searchDraft.value.trim())
    }
  } catch (error) {
    if (sequence !== loadSequence) return
    graph.value = null
    loadedGraphContextKey = null
    store.reportError(error)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadPersonalProjectContext() {
  const [active, ...contexts] = await Promise.all([
    readGraph(projectId.value),
    ...contextIds.value.map((id) => readGraph(id)),
  ])
  return mergeKnowledgeGraphs([active, ...contexts])
}

function readGraph(personalProjectId: string | null): Promise<KnowledgeGraph> {
  const query = new URLSearchParams({ spaceId: spaceId.value, limit: '360' })
  if (scope.value === 'public') {
    const project = publicProject()
    if (project?.providerUrl) query.set('providerUrl', project.providerUrl)
  }
  if (personalProjectId) query.set('personalProjectId', personalProjectId)
  return getJson<KnowledgeGraph>(`/api/graph?${query}`)
}

function publicProject(): PublicProject | null {
  return store.state?.projects.find(({ id }) => id === spaceId.value) ?? null
}

// This workspace's path in a view, optionally with one item's quick look open.
function workspacePath(nextMode: KnowledgeMode, item?: Pick<KnowledgeItem, 'itemKind' | 'id'> | null) {
  const target = { itemKind: item?.itemKind, itemId: item?.id }
  return props.personalProjectsOnly
    ? personalProjectsPath(spaceId.value, nextMode, projectId.value, target)
    : knowledgePath(scope.value, spaceId.value, nextMode, { projectId: projectId.value, ...target })
}

async function changeMode(nextMode: KnowledgeMode, replace = false) {
  const item = selectedItem.value
  const path = workspacePath(nextMode, item)
  const query = { ...route.query }
  if (nextMode === 'graph') delete query.section
  else if (props.personalProjectsOnly && item) {
    if (isManagementKnowledgeItem(item)) query.section = 'materials'
    else delete query.section
  }
  await router[replace ? 'replace' : 'push']({ path, query })
}

async function changeDirectorySection(nextSection: DirectorySection) {
  if (!props.personalProjectsOnly || nextSection === directorySection.value) return
  selectedItem.value = null
  const query = { ...route.query }
  if (nextSection === 'materials') query.section = 'materials'
  else delete query.section
  await router.push({
    path: personalProjectsPath(spaceId.value, 'directory', projectId.value),
    query,
  })
}

async function changeSpace(value: string) {
  const choice = spaceChoices.value.find(({ key }) => key === value)
  if (!choice) return
  const path = props.personalProjectsOnly
    ? personalProjectsPath(choice.spaceId, mode.value, choice.projectId)
    : knowledgePath(choice.scope, choice.spaceId, mode.value, { projectId: choice.projectId })
  await router.push({ path })
}

async function updateQuery(name: string, value: string | string[]) {
  const query = { ...route.query }
  if (
    !value
    || (value === 'all' && name !== 'status')
    || (name === 'status' && value === 'current')
  ) delete query[name]
  else query[name] = value
  await router.replace({ query })
}

function handleSearchInput(value: string) {
  searchDraft.value = value
  cancelGraphSearch()
  resetGraphSearchState()
  searchDebounce.schedule()
}

function submitSearch() {
  searchDebounce.cancel()
  void applySearchDraft()
}

async function applySearchDraft() {
  const draft = searchDraft.value
  const queryText = draft.trim()
  await syncSearchQuery(draft)
  if (searchDraft.value !== draft || mode.value !== 'graph') return
  if (!queryText) {
    cancelGraphSearch()
    resetGraphSearchState()
    return
  }
  if (
    loading.value
    || !graph.value
    || loadedGraphContextKey !== graphContextKey.value
  ) return
  await runGraphSearch(queryText)
}

async function syncSearchQuery(value: string) {
  if (queryValue(route.query.q) === value) return
  pendingRouteSearchQueries.add(value)
  try {
    await updateQuery('q', value)
  } catch (error) {
    store.reportError(error)
  } finally {
    await nextTick()
    pendingRouteSearchQueries.delete(value)
  }
}

function cancelGraphSearch() {
  searching.value = false
  searchSequence += 1
  searchAbortController?.abort()
  searchAbortController = null
}

function resetGraphSearchState() {
  searchMessage.value = ''
  projectDiscovery.value = null
  graphCanvas.value?.clearSelection()
  const item = selectedItem.value
  if (mode.value === 'graph' && item) {
    graphCanvas.value?.selectItem(item.itemKind, item.id)
  }
}

async function runGraphSearch(queryText: string) {
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId) return
  cancelGraphSearch()
  const sequence = searchSequence
  const controller = new AbortController()
  searchAbortController = controller
  projectDiscovery.value = null
  searching.value = true
  searchMessage.value = ''
  const query = new URLSearchParams({ personalSpaceId, q: queryText, limit: '30' })
  if (projectId.value) query.set('personalProjectId', projectId.value)
  for (const id of contextIds.value) query.append('contextPersonalProjectId', id)
  if (scope.value === 'public') query.append('projectId', spaceId.value)
  try {
    const result = await getJson<KnowledgeSearchResult>(
      `/api/search?${query}`,
      { signal: controller.signal },
    )
    if (sequence !== searchSequence) return
    const facts = result.facts ?? []
    const names = new Set([
      ...(result.entities ?? []).map(({ name }) => name),
      ...facts.flatMap(({ source_entity, target_entity }) => [source_entity, target_entity]),
    ])
    const count = graphCanvas.value?.focusByNames(names, { searchMatch: true }) ?? 0
    if (count) {
      searchMessage.value = t('knowledge.workspace.workspace.search.results', {
        entities: result.entities?.length ?? 0,
        relationships: facts.length,
        nodes: count,
      })
      return
    }
    searchMessage.value = t('knowledge.workspace.workspace.search.noResults')
    const canDiscoverProjects = scope.value === 'personal' && !projectId.value
    projectDiscovery.value = {
      query: queryText,
      checking: canDiscoverProjects,
      result: null,
    }
    if (!canDiscoverProjects) return
    const discovery = await discoverPersonalProjectResults({
      personalSpaceId,
      projects: personalProjects.value,
      query: queryText,
      baseline: result,
      signal: controller.signal,
    })
    if (sequence !== searchSequence) return
    projectDiscovery.value = {
      query: queryText,
      checking: false,
      result: discovery,
    }
  } catch (error) {
    if (controller.signal.aborted || sequence !== searchSequence) return
    searchMessage.value = t('knowledge.workspace.workspace.search.failed')
    store.reportError(error)
  } finally {
    if (searchAbortController === controller) {
      searchAbortController = null
      searching.value = false
    }
  }
}

async function selectItem(item: KnowledgeItem) {
  const overviewProjectId = overviewProjectFor(item)
  if (overviewProjectId) {
    await openProjectOverview(overviewProjectId, false)
    return
  }
  // Opening a quick look adds a history entry, so Back closes it; moving
  // from one open item to another replaces it.
  const replace = Boolean(selectedItem.value)
  selectedItem.value = item
  const path = workspacePath(mode.value, item)
  const query = { ...route.query }
  if (mode.value === 'directory' && props.personalProjectsOnly) {
    if (isManagementKnowledgeItem(item)) query.section = 'materials'
    else delete query.section
  }
  peekPushed = peekPushed || !replace
  await router[replace ? 'replace' : 'push']({ path, query })
}

// Closing the quick look goes Back when opening it pushed the entry on
// screen; a deep link or a jump between items drops the item instead.
async function closePeek() {
  if (peekPushed) {
    peekPushed = false
    router.back()
    return
  }
  await router.replace({ path: workspacePath(mode.value), query: route.query })
}

function selectNode(node: KnowledgeNode) {
  const item = selectableItems.value.find(
    ({ itemKind, id }) => itemKind === 'entity' && id === node.id,
  ) ?? knowledgeItemFromNode(node)
  void selectItem(item)
}

function selectEdge(edge: KnowledgeEdge) {
  const item = selectableItems.value.find(
    ({ itemKind, id }) => itemKind === 'relationship' && id === edge.id,
  ) ?? knowledgeItemFromEdge(
    edge,
    new Map(graph.value?.nodes.map((node) => [node.id, node.name]) ?? []),
  )
  void selectItem(item)
}

function selectDeepLinkedItem() {
  const itemKind = route.params.itemKind
  const itemId = route.params.itemId
  if (typeof itemKind !== 'string' || typeof itemId !== 'string') {
    selectedItem.value = null
    return
  }
  const directoryItem = selectableItems.value.find(
    (item) => item.itemKind === itemKind && item.id === itemId,
  )
  const graphItem = itemKind === 'entity'
    ? graph.value?.nodes.find(({ id }) => id === itemId)
    : graph.value?.edges.find(({ id }) => id === itemId)
  selectedItem.value = directoryItem
    ?? (
      itemKind === 'entity' && graphItem
        ? knowledgeItemFromNode(graphItem as KnowledgeNode)
        : itemKind === 'relationship' && graphItem
          ? knowledgeItemFromEdge(
              graphItem as KnowledgeEdge,
              new Map(graph.value?.nodes.map((node) => [node.id, node.name]) ?? []),
            )
          : null
    )
  const overviewProjectId = overviewProjectFor(selectedItem.value)
  if (overviewProjectId) {
    void openProjectOverview(overviewProjectId, true)
    return
  }
  if (selectedItem.value && mode.value === 'directory') {
    const key = knowledgeItemKey(selectedItem.value)
    void nextTick(() => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-item-key]')]
        .find((element) => element.dataset.itemKey === key)
      row?.scrollIntoView?.({ block: 'center' })
      row?.focus({ preventScroll: true })
    })
  }
}

function toggleContext(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const selected = new Set(contextIds.value)
  if (input.checked) selected.add(input.value)
  else selected.delete(input.value)
  void updateQuery('context', [...selected])
}

async function openPersonalProject(nextProjectId: string) {
  await openProjectOverview(nextProjectId, false)
}

function editActiveProjectProfile() {
  if (!activePersonalProject.value) return
  managingMaterialType.value = 'PersonalProject'
  managingProject.value = activePersonalProject.value
}

async function openItemInMode(item: KnowledgeItem, nextMode: KnowledgeMode) {
  const path = workspacePath(nextMode, item)
  const query = { ...route.query }
  if (nextMode === 'directory' && props.personalProjectsOnly) {
    if (isManagementKnowledgeItem(item)) query.section = 'materials'
    else delete query.section
  } else {
    delete query.section
  }
  if (
    nextMode === 'directory'
    && !isManagementKnowledgeItem(item)
    && !filterKnowledgeItems([item], filters.value).length
  ) {
    for (const name of [
      'q', 'type', 'quadrant', 'profile', 'status', 'human',
    ]) delete query[name]
  }
  peekPushed = false
  await router.push({ path, query })
}

async function openReplacement(item: KnowledgeItem) {
  const path = workspacePath('directory', item)
  const query = { ...route.query }
  for (const name of [
    'q', 'type', 'quadrant', 'profile', 'human', 'section',
  ]) delete query[name]
  if (item.invalidAt) query.status = 'historical'
  else delete query.status
  peekPushed = false
  await router.push({ path, query })
}

function manageProjectMaterial(item: KnowledgeItem) {
  const project = projectForMaterial(item)
  if (!project) {
    store.reportError(new Error(t('knowledge.workspace.workspace.errors.projectUnknown')))
    return
  }
  managingMaterialType.value = item.itemKind === 'entity' ? item.type : 'PersonalProject'
  managingProject.value = project
}

function knowledgeMutationProjectId(item: KnowledgeItem | null) {
  return item?.profileAspect ? null : projectId.value
}

function projectForMaterial(item: KnowledgeItem | null) {
  if (!item || !isManagementKnowledgeItem(item)) return null
  const directId = personalProjectIdForItem(item)
  const fallbackId = projectId.value
  const endpointIds = new Set<string>()
  if (item.itemKind === 'entity') endpointIds.add(item.id)
  else {
    const edge = item.raw as KnowledgeEdge
    endpointIds.add(typeof edge.source === 'string' ? edge.source : edge.source.id)
    endpointIds.add(typeof edge.target === 'string' ? edge.target : edge.target.id)
  }
  for (const node of graph.value?.nodes ?? []) {
    if (!endpointIds.has(node.id)) continue
    const candidate = node.attributes?.projectId
    if (typeof candidate === 'string' && candidate) {
      endpointIds.add(candidate)
    }
  }
  if (!directId && !fallbackId) {
    for (const edge of graph.value?.edges ?? []) {
      if (!String(edge.id).startsWith('project-profile-edge:')) continue
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id
      if (!endpointIds.has(source) && !endpointIds.has(target)) continue
      const rootId = endpointIds.has(source) ? target : source
      const root = graph.value?.nodes.find(({ id }) => id === rootId)
      const candidate = root?.attributes?.projectId
      if (typeof candidate === 'string' && candidate) endpointIds.add(candidate)
    }
  }
  const targetId = directId
    ?? fallbackId
    ?? [...endpointIds].find((id) =>
      personalProjects.value.some(({ project_id }) => project_id === id),
    )
  return personalProjects.value.find(({ project_id }) => project_id === targetId) ?? null
}

async function completeProjectProfileUpdate(project: PersonalProject) {
  await store.refresh()
  await loadGraph()
  store.notify(t('knowledge.workspace.workspace.notices.materialUpdated', {
    name: project.profile.name,
  }))
}

function publishPersonalProject(nextProjectId: string) {
  const project = personalProjects.value.find(
    ({ project_id }) => project_id === nextProjectId,
  )
  if (project) publishingProject.value = project
}

async function completeProjectAction(
  result: { status: string },
  targetName: string,
) {
  const messages: Record<string, string> = {
    created: t('knowledge.workspace.workspace.notices.projectCreated', { name: targetName }),
    linked: t('knowledge.workspace.workspace.notices.linked', { name: targetName }),
    already_linked: t('knowledge.workspace.workspace.notices.alreadyLinked', {
      name: targetName,
    }),
    duplicate_reused: t('knowledge.workspace.workspace.notices.duplicateReused', {
      name: targetName,
    }),
    conflict_pending: t('knowledge.workspace.workspace.notices.conflictPending', {
      name: targetName,
    }),
    conflict_resolved: t('knowledge.workspace.workspace.notices.conflictResolved'),
  }
  await store.refresh()
  await loadGraph()
  store.notify(messages[result.status] ?? t('knowledge.workspace.workspace.notices.scopeUpdated'))
}

function sourceLabel(item: KnowledgeItem) {
  if (item.profileAspect) {
    const scopeLabel = item.preferenceScope === 'project'
      ? t('knowledge.workspace.workspace.source.projectPreference')
      : t('knowledge.workspace.workspace.source.personalGlobal')
    const evidenceLabel = item.evidence.length
      ? t('common.counts.sources', { count: item.evidence.length })
      : t('knowledge.workspace.workspace.source.noSources')
    return `${scopeLabel} · ${evidenceLabel}`
  }
  const assignment = item.assignments.at(0) as { project_id?: string } | undefined
  const evidenceProject = item.evidence.find(({ personal_project_id }) => personal_project_id)
    ?.personal_project_id
  const id = assignment?.project_id ?? evidenceProject
  const name = personalProjects.value.find(({ project_id }) => project_id === id)
    ?.profile.name
  const scopeLabel = name
    ? t('knowledge.workspace.workspace.source.primaryProject', { name })
    : t('knowledge.workspace.workspace.source.personalGlobal')
  return `${scopeLabel} · ${t('common.counts.sources', { count: item.evidence.length })}`
}


function choiceKey(choiceScope: KnowledgeScope, choiceSpaceId: string, choiceProjectId: string | null) {
  return JSON.stringify([choiceScope, choiceSpaceId, choiceProjectId])
}

function queryValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function queryValues(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' ? [value] : []
}

</script>

<template>
  <section
    class="view graph-view vue-knowledge-view"
    :class="{ 'graph-canvas-active': mode === 'graph', 'is-project-overview': mode === 'overview' }"
  >
    <div class="knowledge-canvas">
    <div class="knowledge-view-heading">
      <!-- The view is part of the URL; the tabs only change the route. -->
      <Tabs :model-value="mode" class="knowledge-mode-tabs" @update:model-value="changeMode($event as KnowledgeMode)">
        <TabsList :aria-label="t('knowledge.workspace.workspace.view.modeAria')">
          <TabsTrigger v-if="overviewAvailable" value="overview" data-knowledge-mode="overview">{{ t('projects.overview.tab') }}</TabsTrigger>
          <TabsTrigger value="directory" data-knowledge-mode="directory">{{ t('knowledge.workspace.workspace.view.directory') }}</TabsTrigger>
          <TabsTrigger value="graph" data-knowledge-mode="graph">{{ t('knowledge.workspace.workspace.view.graph') }}</TabsTrigger>
        </TabsList>
      </Tabs>
      <template v-if="mode !== 'overview'">
        <GrowthLoading v-if="organize.pendingLabel" variant="inline" :label="organize.pendingLabel" />
        <span v-else-if="organize.failure && organizeAvailable" class="organize-failure" role="alert">{{ organize.failure }}</span>
        <GrowthLoading v-else-if="searching && !projectDiscovery?.checking" variant="inline" :label="t('knowledge.workspace.workspace.search.searching')" />
        <GrowthLoading v-else-if="loading && graph && !showInitialLoading && (mode !== 'graph' || graphView?.nodes.length)" variant="inline" :label="t('common.status.loadingKnowledge')" />
        <span v-else-if="mode === 'graph' && !showInitialLoading" class="muted">{{ countLabel }}</span>
      </template>
    </div>

    <template v-if="mode === 'overview'">
      <ProjectOverview
        v-if="activePersonalProject"
        :space-id="spaceId"
        :project="activePersonalProject"
        :frequent-projects="activeFrequentProjects"
        :can-publish="Boolean(store.state?.capabilities?.publishProject)"
        @edit-profile="editActiveProjectProfile"
        @publish="publishingProject = activePersonalProject"
      />
      <GrowthLoading
        v-else-if="!store.state && store.runtimeStatus !== 'error' || store.runtimeStatus === 'loading'"
        :label="t('common.status.loadingConsole')"
      />
      <div v-else-if="!store.state" class="project-overview-failed" role="alert">
        <p>{{ t('common.errors.loadFailed') }}</p>
        <Button variant="outline" @click="store.refresh">{{ t('common.actions.retry') }}</Button>
      </div>
      <p v-else class="muted" role="status">{{ t('knowledge.workspace.workspace.errors.projectUnknown') }}</p>
    </template>

    <template v-else>
    <div class="graph-toolbar">
      <UiSelect
        :model-value="selectedChoiceKey"
        :options="spaceSelectOptions"
        :label="t('knowledge.workspace.workspace.view.graphSpace')"
        control-id="graph-space"
        searchable
        @update:model-value="changeSpace"
      />
      <label v-if="personalProjectsOnly" class="project-visibility-toggle">
        <UiToggle v-model="showTemporaryProjects" :label="t('knowledge.workspace.workspace.view.showTemporaryProjects')" />
        <span>{{ t('knowledge.workspace.workspace.view.showTemporaryProjects') }}</span>
      </label>
      <label v-if="organizeAvailable" class="project-visibility-toggle">
        <UiToggle :model-value="organize.enabled" :label="t('projects.organize.toggle')" @update:model-value="organize.setEnabled" />
        <span>{{ t('projects.organize.toggle') }}</span>
      </label>
      <CreateProjectEntry v-if="personalProjectsOnly && spaceId" :space-id="spaceId" />

      <details v-if="projectId && availableContexts.length" class="personal-context-picker">
        <summary>
          {{ t('knowledge.workspace.workspace.view.borrowProjects') }}
          <span>{{ contextIds.length
            ? t('knowledge.workspace.workspace.view.selectedContexts', { count: contextIds.length })
            : t('knowledge.workspace.workspace.view.noneSelected') }}</span>
          <i class="picker-chevron" aria-hidden="true" />
        </summary>
        <div class="personal-context-panel">
          <strong>{{ t('knowledge.workspace.workspace.view.currentContext') }}</strong>
          <p>{{ t('knowledge.workspace.workspace.view.contextCopy') }}</p>
          <div class="personal-context-list">
            <label v-for="project in availableContexts" :key="project.project_id" class="personal-context-option">
              <input
                type="checkbox"
                :value="project.project_id"
                :checked="contextIds.includes(project.project_id)"
                @change="toggleContext"
              />
              <span><strong>{{ project.profile.name }}</strong><small>{{ t('knowledge.workspace.workspace.view.currentScopeOnly') }}</small></span>
            </label>
          </div>
        </div>
      </details>

      <form class="search-form" role="search" :aria-label="t('knowledge.workspace.workspace.search.aria')" @submit.prevent="submitSearch">
        <Input
          type="search"
          :placeholder="
            mode === 'directory' && directorySection === 'materials'
              ? t('knowledge.workspace.workspace.search.materialsPlaceholder')
              : t('knowledge.workspace.workspace.search.contentPlaceholder')
          "
          :aria-label="
            mode === 'directory' && directorySection === 'materials'
              ? t('knowledge.workspace.workspace.search.materialsPlaceholder')
              : t('knowledge.workspace.workspace.search.knowledgeAria')
          "
          autocomplete="off"
          enterkeyhint="search"
          :model-value="searchDraft"
          @update:model-value="handleSearchInput(String($event))"
        />
      </form>
      <div class="graph-view-actions">
        <Button size="sm" variant="ghost"
          v-if="
            personalProjectsOnly
              && activePersonalProject
              && store.state?.capabilities?.publishProject
          "
          @click="publishingProject = activePersonalProject"
        >
          {{ t('knowledge.workspace.workspace.view.publishProject') }}
        </Button>
        <div v-if="mode === 'graph'" class="graph-controls" role="group" :aria-label="t('knowledge.workspace.workspace.view.graphControls')">
          <Button size="sm" variant="ghost" :aria-label="t('knowledge.workspace.workspace.view.zoomOut')" @click="graphCanvas?.zoomOut()">−</Button>
          <Button size="sm" variant="ghost" :aria-label="t('knowledge.workspace.workspace.view.zoomIn')" @click="graphCanvas?.zoomIn()">＋</Button>
          <Button size="sm" variant="ghost" @click="graphCanvas?.fit()">{{ t('knowledge.workspace.workspace.view.fit') }}</Button>
          <Button size="sm" variant="ghost" @click="graphCanvas?.reset()">{{ t('knowledge.workspace.workspace.view.reset') }}</Button>
        </div>
        <Button size="icon-sm" variant="ghost" :aria-label="t('common.actions.refresh')" :title="t('common.actions.refresh')" @click="loadGraph"><span aria-hidden="true">↻</span></Button>
      </div>
    </div>

    <UiDisclosure v-if="mode === 'directory' && directorySection === 'knowledge'" class="knowledge-filter-disclosure" :title="t('ui.filters')" :open="filters.type !== 'all' || filters.quadrant !== 'all' || filters.profile !== 'all' || filters.humanChange !== 'all'">
      <div class="knowledge-filter-controls">
        <UiSelect
          :model-value="filters.type"
          :options="typeSelectOptions"
          :label="t('knowledge.workspace.workspace.view.contentType')"
          control-id="knowledge-type-filter"
          @update:model-value="updateQuery('type', $event)"
        />
        <UiSelect
          :model-value="filters.quadrant"
          :options="quadrantSelectOptions"
          :label="t('knowledge.workspace.workspace.view.discoveryQuadrant')"
          control-id="knowledge-quadrant-filter"
          @update:model-value="updateQuery('quadrant', $event)"
        />
        <UiSelect
          :model-value="filters.profile"
          :options="profileSelectOptions"
          :label="t('knowledge.workspace.workspace.view.classification')"
          control-id="knowledge-profile-filter"
          @update:model-value="updateQuery('profile', $event)"
        />
        <UiSelect
          :model-value="filters.humanChange"
          :options="humanChangeSelectOptions"
          :label="t('knowledge.workspace.workspace.view.humanChangeStatus')"
          control-id="knowledge-human-change-filter"
          @update:model-value="updateQuery('human', $event)"
        />
      </div>
    </UiDisclosure>

    <GrowthLoading
      v-if="showInitialLoading"
      :label="t('common.status.loadingKnowledge')"
    />
    <div v-else-if="initialLoading" class="view-loading" aria-busy="true" />
    <div v-else class="knowledge-layout">
      <KnowledgeDirectoryPanel
        v-if="mode === 'directory'"
        :personal-projects-only="personalProjectsOnly"
        :directory-section="directorySection"
        :knowledge-tab-count="knowledgeTabCount"
        :material-tab-count="materialTabCount"
        :content-status="contentStatus"
        :current-item-count="currentItemCount"
        :historical-item-count="historicalItemCount"
        :all-items="allItems"
        :visible-items="visibleItems"
        :project-material-items="projectMaterialItems"
        :visible-project-material-items="visibleProjectMaterialItems"
        :selected-item="selectedItem"
        :list-reset-key="directoryListResetKey"
        :source-label="sourceLabel"
        @change-section="changeDirectorySection"
        @update-status="updateQuery('status', $event)"
        @select-item="selectItem"
      />

      <div
        v-else
        class="graph-stage"
        :class="{ 'has-parent-projects': parentProjects.length }"
      >
        <ProjectHierarchyAside
          :parents="parentProjects"
          :active-project-name="activePersonalProject?.profile.name"
          :space-id="spaceId"
        />

        <div class="graph-canvas-panel" :class="{ 'is-organizing': organizeAvailable && organize.enabled }">
          <GraphSearchStatus v-if="projectDiscovery" :discovery="projectDiscovery" :space-id="spaceId" />
          <GraphRelationLegend :relation-types="graphRelationTypes" />
          <GraphCanvas
            :project-visibility="personalProjectsOnly ? 'provided' : 'formal'"
            v-if="graphView?.nodes.length"
            ref="graphCanvas"
            :graph="graphView"
            :selected-item="selectedItem"
            :organize-projects="organizeAvailable && organize.enabled"
            @select-node="selectNode"
            @select-edge="selectEdge"
            @project-drag="organize.onProjectDrag"
          />
          <GrowthLoading v-else-if="loading" variant="compact" :label="t('common.status.loadingKnowledge')" />
          <div v-else class="graph-empty">{{ t('knowledge.workspace.workspace.view.noGraph') }}</div>
          <ProjectDropPanel v-if="organize.dragging" :tree="organize.tree" :project="organize.dragging" :hovered="organize.hovered" />
        </div>
      </div>
    </div>
    <p v-if="mode === 'graph'" class="graph-hint">{{ t('knowledge.workspace.workspace.view.graphHint') }}</p>
    <KnowledgePeek
      :item="selectedItem"
      :suspended="peekSuspended"
      :graph="graph"
      :editable="editable"
      :current-project-id="projectId"
      :can-publish-project="store.state?.capabilities?.publishProject"
      :can-manage-project="Boolean(manageableSelectedProject)"
      :mode="mode"
      @confirm="confirmingItem = $event"
      @edit="editingItem = $event"
      @create-project="projectActionItem = $event"
      @open-project="openPersonalProject"
      @publish-project="publishPersonalProject"
      @open-directory="openItemInMode($event, 'directory')"
      @open-graph="openItemInMode($event, 'graph')"
      @open-replacement="openReplacement"
      @manage-project="manageProjectMaterial"
      @close="closePeek"
    />
    </template>
    </div>

    <KnowledgeWorkspaceDialogs
      :editing-item="editingItem"
      :confirming-item="confirmingItem"
      :project-action-item="projectActionItem"
      :publishing-project="publishingProject"
      :managing-project="managingProject"
      :managing-material-type="managingMaterialType"
      :personal-space-id="store.activePersonalSpace?.id ?? spaceId"
      :editing-project-id="knowledgeMutationProjectId(editingItem)"
      :confirming-project-id="knowledgeMutationProjectId(confirmingItem)"
      :current-project-id="projectId"
      :projects="store.state?.personalProjects ?? []"
      :replacement-items="allItems"
      @close-edit="editingItem = null"
      @close-confirm="confirmingItem = null"
      @close-project-action="projectActionItem = null"
      @close-publish="publishingProject = null"
      @close-profile="managingProject = null"
      @refresh="loadGraph"
      @access-denied="revokeKnowledgeAccess"
      @project-saved="completeProjectAction"
      @profile-saved="completeProjectProfileUpdate"
    />
  </section>
</template>

<style scoped>
.organize-failure {
  color: var(--color-danger);
  font-size: 13px;
}
.project-visibility-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
  white-space: nowrap;
}
</style>
