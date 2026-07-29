<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { getJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
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
import KnowledgeConfirmDialog from './KnowledgeConfirmDialog.vue'
import KnowledgeEditDialog from './KnowledgeEditDialog.vue'
import KnowledgeInspector from './KnowledgeInspector.vue'
import KnowledgeProjectDialog from '@/features/projects/KnowledgeProjectDialog.vue'
import PersonalProjectProfileDialog from '@/features/projects/PersonalProjectProfileDialog.vue'
import PublishProjectDialog from '@/features/projects/PublishProjectDialog.vue'
import {
  currentKnowledgeGraph,
  filterKnowledgeItems,
  formatTime,
  isManagementKnowledgeItem,
  knowledgeItemFromEdge,
  knowledgeItemFromNode,
  knowledgeItems,
  knowledgeReviewState,
  humanChangeStatusLabel,
  latestItemValue,
  managementKnowledgeItems,
  mergeKnowledgeGraphs,
  personalProjectIdForItem,
  profileAspectLabel,
  projectMaterialTypeLabel,
  quadrantLabel,
  reviewStateLabel,
} from './model'
import {
  discoverPersonalProjectResults,
  projectDiscoverySummary,
  type KnowledgeSearchResult,
  type PersonalProjectDiscovery,
} from './project-discovery'

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
const graph = ref<KnowledgeGraph | null>(null)
const selectedItem = ref<KnowledgeItem | null>(null)
const graphCanvas = ref<GraphCanvasApi | null>(null)
const searchDraft = ref(queryValue(route.query.q))
const searchMessage = ref('')
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

const mode = computed<KnowledgeMode>(() => route.params.mode === 'graph' ? 'graph' : 'directory')
const scope = computed<KnowledgeScope>(() => {
  if (props.personalProjectsOnly) return 'personal'
  return route.params.scope === 'public' ? 'public' : 'personal'
})
const spaceId = computed(() => String(route.params.spaceId ?? store.activePersonalSpace?.id ?? ''))
const projectId = computed(() => {
  const value = route.params.projectId
  return typeof value === 'string' && value ? value : null
})
const contextIds = computed(() => queryValues(route.query.context))
const graphContextKey = computed(() => JSON.stringify([
  props.personalProjectsOnly,
  scope.value,
  spaceId.value,
  projectId.value,
  contextIds.value,
]))
const allItems = computed(() => knowledgeItems(graph.value))
const projectMaterialItems = computed(() =>
  props.personalProjectsOnly ? managementKnowledgeItems(graph.value) : [],
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
  ...projectMaterialItems.value,
  ...allItems.value,
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
  { value: 'all', label: '全部类型' },
  ...typeOptions.value.map((type) => ({ value: type, label: type })),
])
const quadrantSelectOptions = [
  { value: 'all', label: '全部象限' },
  { value: 'known_known', label: '已知的已知' },
  { value: 'known_unknown', label: '已知的未知' },
  { value: 'unknown_known', label: '未知的已知' },
  { value: 'unknown_unknown', label: '未知的未知' },
]
const profileSelectOptions = [
  { value: 'all', label: '全部知识' },
  { value: 'profile', label: '协作偏好' },
  { value: 'regular', label: '项目与通用知识' },
]
const humanChangeSelectOptions = [
  { value: 'all', label: '全部人工状态' },
  { value: 'human_changed', label: '人工改过（全部）' },
  { value: 'unseen', label: 'Agent 未查看' },
  { value: 'viewed', label: '已查看待审核' },
  { value: 'reviewed', label: 'Agent 已审核' },
]
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
const visibleItems = computed(() => filterKnowledgeItems(allItems.value, filters.value))
const currentItemCount = computed(() => allItems.value.filter(({ invalidAt }) => !invalidAt).length)
const historicalItemCount = computed(() => allItems.value.length - currentItemCount.value)
const selectedStatusTotal = computed(() => {
  if (contentStatus.value === 'current') return currentItemCount.value
  if (contentStatus.value === 'historical') return historicalItemCount.value
  return allItems.value.length
})
const selectedStatusLabel = computed(() => {
  if (contentStatus.value === 'current') return '当前有效'
  if (contentStatus.value === 'historical') return '已失效'
  return '全部状态'
})
const graphView = computed(() => graph.value ? currentKnowledgeGraph(graph.value) : null)
const countLabel = computed(() => {
  if (!graph.value) return loading.value ? '正在读取知识…' : '尚未读取图谱'
  if (mode.value === 'graph') {
    const value = graphView.value
    return searchMessage.value || `${value?.nodes.length ?? 0} 个节点 · ${value?.edges.length ?? 0} 条当前关系`
  }
  if (directorySection.value === 'materials') {
    return visibleProjectMaterialItems.value.length === projectMaterialItems.value.length
      ? `${projectMaterialItems.value.length} 条项目资料`
      : `显示 ${visibleProjectMaterialItems.value.length} / ${projectMaterialItems.value.length} 条项目资料`
  }
  const knowledgeCount = visibleItems.value.length === selectedStatusTotal.value
    ? `${selectedStatusLabel.value} ${selectedStatusTotal.value} 条知识内容`
    : `${selectedStatusLabel.value}：显示 ${visibleItems.value.length} / ${
      selectedStatusTotal.value
    } 条知识内容`
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
  personalProjects.value.filter(({ project_id }) => project_id !== projectId.value),
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
      label: `全部个人项目 · ${space.name}`,
    }
    const projects = (state.personalProjects ?? [])
      .filter(({ personal_space_id }) => personal_space_id === space.id)
      .map((project): SpaceChoice => ({
        key: choiceKey('personal', space.id, project.project_id),
        scope: 'personal',
        spaceId: space.id,
        projectId: project.project_id,
        providerUrl: null,
        label: `个人项目 · ${project.profile.name}`,
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
    label: `公共项目 · ${project.name}`,
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
  store.state?.personalProjects?.find(({ project_id }) => project_id === projectId.value) ?? null,
)
const manageableSelectedProject = computed(() =>
  projectForMaterial(selectedItem.value),
)
const projectDiscoveryCopy = computed(() => {
  if (!projectDiscovery.value) return ''
  if (projectDiscovery.value.checking) {
    return '当前范围没有命中，正在检查其他个人项目…'
  }
  if (projectDiscovery.value.result) return projectDiscoverySummary(projectDiscovery.value.result)
  return '当前范围没有找到可定位的内容，可以调整关键词后重试。'
})

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
  () => selectDeepLinkedItem(),
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
  if (route.params.mode !== 'directory' && route.params.mode !== 'graph') {
    await changeMode(props.personalProjectsOnly ? 'graph' : 'directory', true)
  }
}

async function loadGraph() {
  if (!spaceId.value || spaceId.value === 'current') return
  const contextKey = graphContextKey.value
  const sequence = ++loadSequence
  cancelGraphSearch()
  loading.value = true
  selectedItem.value = null
  resetGraphSearchState()
  try {
    const value = projectId.value && scope.value === 'personal'
      ? await loadPersonalProjectContext()
      : await readGraph(projectId.value)
    if (sequence !== loadSequence) return
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

async function changeMode(nextMode: KnowledgeMode, replace = false) {
  const item = selectedItem.value
  const path = props.personalProjectsOnly
    ? personalProjectsPath(spaceId.value, nextMode, projectId.value, {
        itemKind: item?.itemKind,
        itemId: item?.id,
      })
    : knowledgePath(scope.value, spaceId.value, nextMode, {
        projectId: projectId.value,
        itemKind: item?.itemKind,
        itemId: item?.id,
      })
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
  if (searchDraft.value !== draft || mode.value === 'directory') return
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
  searchMessage.value = '正在搜索…'
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
      searchMessage.value = `找到 ${result.entities?.length ?? 0} 个实体 · ${facts.length} 条关系 · 图中高亮 ${count} 个节点`
      return
    }
    searchMessage.value = '当前范围未检索到匹配结果'
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
    searchMessage.value = '搜索失败'
    store.reportError(error)
  } finally {
    if (searchAbortController === controller) searchAbortController = null
  }
}

async function selectItem(item: KnowledgeItem) {
  selectedItem.value = item
  const path = props.personalProjectsOnly
    ? personalProjectsPath(spaceId.value, mode.value, projectId.value, {
        itemKind: item.itemKind,
        itemId: item.id,
      })
    : knowledgePath(scope.value, spaceId.value, mode.value, {
        projectId: projectId.value,
        itemKind: item.itemKind,
        itemId: item.id,
      })
  const query = { ...route.query }
  if (mode.value === 'directory' && props.personalProjectsOnly) {
    if (isManagementKnowledgeItem(item)) query.section = 'materials'
    else delete query.section
  }
  await router.replace({ path, query })
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
  if (selectedItem.value && mode.value === 'directory') {
    const key = itemKey(selectedItem.value)
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
  await router.push(personalProjectsPath(spaceId.value, mode.value, nextProjectId))
}

async function openItemInMode(item: KnowledgeItem, nextMode: KnowledgeMode) {
  const path = props.personalProjectsOnly
    ? personalProjectsPath(spaceId.value, nextMode, projectId.value, {
        itemKind: item.itemKind,
        itemId: item.id,
      })
    : knowledgePath(scope.value, spaceId.value, nextMode, {
        projectId: projectId.value,
        itemKind: item.itemKind,
        itemId: item.id,
      })
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
  await router.push({ path, query })
}

async function openReplacement(item: KnowledgeItem) {
  const path = props.personalProjectsOnly
    ? personalProjectsPath(spaceId.value, 'directory', projectId.value, {
        itemKind: item.itemKind,
        itemId: item.id,
      })
    : knowledgePath(scope.value, spaceId.value, 'directory', {
        projectId: projectId.value,
        itemKind: item.itemKind,
        itemId: item.id,
      })
  const query = { ...route.query }
  for (const name of [
    'q', 'type', 'quadrant', 'profile', 'human', 'section',
  ]) delete query[name]
  if (item.invalidAt) query.status = 'historical'
  else delete query.status
  await router.push({ path, query })
}

function manageProjectMaterial(item: KnowledgeItem) {
  const project = projectForMaterial(item)
  if (!project) {
    store.reportError(new Error('无法确定这条项目资料所属的个人项目'))
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
      store.state?.personalProjects?.some(({ project_id }) => project_id === id),
    )
  return store.state?.personalProjects?.find(({ project_id }) => project_id === targetId) ?? null
}

async function completeProjectProfileUpdate(project: PersonalProject) {
  await store.refresh()
  await loadGraph()
  store.notify(`“${project.profile.name}”的项目资料已更新。`)
}

function publishPersonalProject(nextProjectId: string) {
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === nextProjectId,
  )
  if (project) publishingProject.value = project
}

async function completeProjectAction(
  result: { status: string },
  targetName: string,
) {
  const messages: Record<string, string> = {
    created: `个人项目“${targetName}”已创建。`,
    linked: `这条知识已加入“${targetName}”，主要归属保持不变。`,
    already_linked: `“${targetName}”已经在使用这条知识。`,
    duplicate_reused: `“${targetName}”已有相同内容，已复用现有节点。`,
    conflict_pending: `已保留项目操作；冲突内容暂不在“${targetName}”生效。`,
    conflict_resolved: '冲突已按当前选择处理，并保留处理记录。',
  }
  await store.refresh()
  await loadGraph()
  store.notify(messages[result.status] ?? '项目知识范围已更新。')
}

function sourceLabel(item: KnowledgeItem) {
  if (item.profileAspect) {
    return `${item.preferenceScope === 'project' ? '项目偏好' : '个人全局'} · ${
      item.evidence.length ? `${item.evidence.length} 个来源` : '无来源记录'
    }`
  }
  const assignment = item.assignments.at(0) as { project_id?: string } | undefined
  const evidenceProject = item.evidence.find(({ personal_project_id }) => personal_project_id)
    ?.personal_project_id
  const id = assignment?.project_id ?? evidenceProject
  const name = store.state?.personalProjects?.find(({ project_id }) => project_id === id)
    ?.profile.name
  return `${name ? `主要 ${name}` : '个人全局'} · ${item.evidence.length} 个来源`
}

function itemKey(item: Pick<KnowledgeItem, 'itemKind' | 'id'>) {
  return `${item.itemKind}:${item.id}`
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
  <section class="view graph-view vue-knowledge-view">
    <div class="knowledge-view-heading">
      <div class="knowledge-mode-switch" role="tablist" aria-label="知识查看方式">
        <button type="button" role="tab" :aria-selected="mode === 'directory'" @click="changeMode('directory')">内容目录</button>
        <button type="button" role="tab" :aria-selected="mode === 'graph'" @click="changeMode('graph')">关系图谱</button>
      </div>
      <span class="muted">{{ countLabel }}</span>
    </div>

    <div class="graph-toolbar">
      <SearchableSelect
        :model-value="selectedChoiceKey"
        :options="spaceSelectOptions"
        label="图谱空间"
        control-id="graph-space"
        searchable
        @update:model-value="changeSpace"
      />

      <details v-if="projectId && availableContexts.length" class="personal-context-picker">
        <summary>
          借鉴其他项目
          <span>{{ contextIds.length ? `已选 ${contextIds.length}` : '未选择' }}</span>
          <i class="searchable-select-arrow" aria-hidden="true" />
        </summary>
        <div class="personal-context-panel">
          <strong>本次上下文</strong>
          <p>只加入当前查看和查询，不改变知识归属。</p>
          <div class="personal-context-list">
            <label v-for="project in availableContexts" :key="project.project_id" class="personal-context-option">
              <input
                type="checkbox"
                :value="project.project_id"
                :checked="contextIds.includes(project.project_id)"
                @change="toggleContext"
              />
              <span><strong>{{ project.profile.name }}</strong><small>仅加入当前范围</small></span>
            </label>
          </div>
        </div>
      </details>

      <form class="search-form" role="search" aria-label="知识搜索" @submit.prevent="submitSearch">
        <input
          type="search"
          :placeholder="
            mode === 'directory' && directorySection === 'materials'
              ? '搜索项目资料'
              : '搜索内容、来源或关系'
          "
          :aria-label="
            mode === 'directory' && directorySection === 'materials'
              ? '搜索项目资料'
              : '搜索知识内容'
          "
          autocomplete="off"
          enterkeyhint="search"
          :value="searchDraft"
          @input="handleSearchInput(($event.currentTarget as HTMLInputElement).value)"
        />
      </form>

      <template v-if="mode === 'directory' && directorySection === 'knowledge'">
        <SearchableSelect
          :model-value="filters.type"
          :options="typeSelectOptions"
          label="内容类型"
          control-id="knowledge-type-filter"
          @update:model-value="updateQuery('type', $event)"
        />
        <SearchableSelect
          :model-value="filters.quadrant"
          :options="quadrantSelectOptions"
          label="发现时象限"
          control-id="knowledge-quadrant-filter"
          @update:model-value="updateQuery('quadrant', $event)"
        />
        <SearchableSelect
          :model-value="filters.profile"
          :options="profileSelectOptions"
          label="知识归类"
          control-id="knowledge-profile-filter"
          @update:model-value="updateQuery('profile', $event)"
        />
        <SearchableSelect
          :model-value="filters.humanChange"
          :options="humanChangeSelectOptions"
          label="人工变更状态"
          control-id="knowledge-human-change-filter"
          @update:model-value="updateQuery('human', $event)"
        />
      </template>

      <div class="graph-view-actions">
        <button
          v-if="
            personalProjectsOnly
              && activePersonalProject
              && store.state?.capabilities?.publishProject
          "
          class="toolbar-action"
          type="button"
          @click="publishingProject = activePersonalProject"
        >
          发布当前项目
        </button>
        <div v-if="mode === 'graph'" class="graph-controls" role="group" aria-label="图谱视图控制">
          <button class="toolbar-action" type="button" aria-label="缩小图谱" @click="graphCanvas?.zoomOut()">−</button>
          <button class="toolbar-action" type="button" aria-label="放大图谱" @click="graphCanvas?.zoomIn()">＋</button>
          <button class="toolbar-action" type="button" @click="graphCanvas?.fit()">适应</button>
          <button class="toolbar-action" type="button" @click="graphCanvas?.reset()">重置</button>
        </div>
        <button class="toolbar-action" type="button" @click="loadGraph">刷新</button>
      </div>
    </div>

    <div v-if="loading && !graph" class="view-loading">正在读取知识…</div>
    <div v-else class="knowledge-layout">
      <section
        v-if="mode === 'directory'"
        class="knowledge-directory-panel"
        :class="{ 'has-directory-tabs': personalProjectsOnly }"
        :aria-label="directorySection === 'materials' ? '项目资料目录' : '知识内容目录'"
      >
        <div
          v-if="personalProjectsOnly"
          class="directory-kind-tabs"
          role="tablist"
          aria-label="目录内容类型"
        >
          <button
            id="directory-tab-knowledge"
            class="directory-kind-tab"
            type="button"
            role="tab"
            aria-controls="directory-panel-knowledge"
            :aria-selected="directorySection === 'knowledge'"
            @click="changeDirectorySection('knowledge')"
          >
            <span>知识内容</span>
            <small>{{ knowledgeTabCount }}</small>
          </button>
          <button
            id="directory-tab-materials"
            class="directory-kind-tab"
            type="button"
            role="tab"
            aria-controls="directory-panel-materials"
            :aria-selected="directorySection === 'materials'"
            @click="changeDirectorySection('materials')"
          >
            <span>项目资料</span>
            <small>{{ materialTabCount }}</small>
          </button>
        </div>

        <div
          v-if="directorySection === 'knowledge'"
          id="directory-panel-knowledge"
          class="directory-tab-panel"
          role="tabpanel"
          aria-labelledby="directory-tab-knowledge"
        >
          <header class="directory-section-heading">
            <div class="directory-section-copy">
              <strong>知识内容</strong>
              <span>可确认、纠正、失效或恢复的知识记录。</span>
            </div>
            <div class="knowledge-status-filter" role="group" aria-label="知识内容状态">
              <button
                class="knowledge-status-option"
                data-status="current"
                type="button"
                :aria-pressed="contentStatus === 'current'"
                @click="updateQuery('status', 'current')"
              >
                当前有效 <span>{{ currentItemCount }}</span>
              </button>
              <button
                class="knowledge-status-option"
                data-status="historical"
                type="button"
                :aria-pressed="contentStatus === 'historical'"
                @click="updateQuery('status', 'historical')"
              >
                已失效 <span>{{ historicalItemCount }}</span>
              </button>
              <button
                class="knowledge-status-option"
                data-status="all"
                type="button"
                :aria-pressed="contentStatus === 'all'"
                @click="updateQuery('status', 'all')"
              >
                全部 <span>{{ allItems.length }}</span>
              </button>
            </div>
            <small class="directory-section-count">{{ visibleItems.length }} 条</small>
          </header>
          <div class="knowledge-table-head" aria-hidden="true">
            <span class="knowledge-column-content">内容</span>
            <span class="knowledge-column-quadrant">发现时象限</span>
            <span class="knowledge-column-review">确认状态</span>
            <span class="knowledge-column-type">类型</span>
            <span class="knowledge-column-source">来源</span>
            <span class="knowledge-column-time">更新时间</span>
            <span class="knowledge-column-validity">有效性</span>
          </div>
          <div class="knowledge-directory-list">
            <button
              v-for="item in visibleItems"
              :key="`${item.itemKind}:${item.id}`"
              class="knowledge-row"
              :class="{
                selected: selectedItem?.itemKind === item.itemKind
                  && selectedItem?.id === item.id,
              }"
              type="button"
              :data-item-key="itemKey(item)"
              @click="selectItem(item)"
            >
              <span class="knowledge-row-content">
                <span class="knowledge-row-title">
                  <strong>{{ item.title }}</strong>
                  <em
                    v-if="
                      item.humanChangeStatus === 'unseen'
                      || item.humanChangeStatus === 'viewed'
                    "
                    class="human-change-badge"
                    :class="`state-${item.humanChangeStatus}`"
                  >
                    {{ humanChangeStatusLabel(item.humanChangeStatus) }}
                  </em>
                </span>
                <small>{{ item.profileAspect ? `${profileAspectLabel(item.profileAspect)} · ${item.body}` : item.body }}</small>
              </span>
              <span class="knowledge-row-quadrant" :class="item.originQuadrant">{{ quadrantLabel(item.originQuadrant) }}</span>
              <span class="knowledge-review-state" :class="`state-${knowledgeReviewState(item)}`">{{ reviewStateLabel(item) }}</span>
              <span class="knowledge-row-type">{{ item.type }}</span>
              <span class="knowledge-row-source">{{ sourceLabel(item) }}</span>
              <span class="knowledge-row-time">{{ formatTime(latestItemValue(item)) }}</span>
              <span class="knowledge-status" :class="item.invalidAt ? 'historical' : 'current'">{{ item.invalidAt ? '已失效' : '有效' }}</span>
            </button>
          </div>
          <div v-if="!visibleItems.length" class="empty-state">
            {{
              allItems.length
                ? '当前筛选条件下没有知识内容'
                : '这个项目还没有可确认或翻转状态的知识内容'
            }}
          </div>
        </div>

        <div
          v-else
          id="directory-panel-materials"
          class="directory-tab-panel"
          role="tabpanel"
          aria-labelledby="directory-tab-materials"
        >
          <header class="directory-section-heading">
            <div class="directory-section-copy">
              <strong>项目资料</strong>
              <span>项目目标、范围和结构关系；通过“编辑项目资料”修改。</span>
            </div>
            <small class="directory-section-count">{{ visibleProjectMaterialItems.length }} 条</small>
          </header>
          <div class="project-material-list">
            <button
              v-for="item in visibleProjectMaterialItems"
              :key="itemKey(item)"
              class="project-material-row"
              :class="{
                selected: selectedItem?.itemKind === item.itemKind
                  && selectedItem?.id === item.id,
              }"
              type="button"
              :data-item-key="itemKey(item)"
              @click="selectItem(item)"
            >
              <span class="project-material-copy">
                <strong>{{ item.itemKind === 'entity' ? item.title : item.type }}</strong>
                <small>{{ item.body }}</small>
              </span>
              <span class="project-material-type">{{ projectMaterialTypeLabel(item) }}</span>
              <span class="project-material-link">查看详情 →</span>
            </button>
          </div>
          <div v-if="!visibleProjectMaterialItems.length" class="empty-state">
            {{
              projectMaterialItems.length
                ? '当前搜索条件下没有项目资料'
                : '这个项目还没有项目资料'
            }}
          </div>
        </div>
      </section>

      <div v-else class="graph-stage">
        <aside v-if="projectDiscovery" class="graph-search-status" aria-live="polite">
          <span class="graph-search-status-kicker">当前范围未命中</span>
          <strong class="graph-search-status-title">没有检索到“{{ projectDiscovery.query }}”</strong>
          <p class="graph-search-status-copy">{{ projectDiscoveryCopy }}</p>
          <div
            v-if="projectDiscovery.result?.matches.length"
            class="graph-search-suggestions"
          >
            <RouterLink
              v-for="match in projectDiscovery.result.matches.slice(0, 5)"
              :key="match.project.project_id"
              class="graph-search-suggestion"
              :to="{
                path: personalProjectsPath(
                  spaceId,
                  'graph',
                  match.project.project_id,
                ),
                query: { q: projectDiscovery.query },
              }"
            >
              <span>
                <strong>{{ match.project.profile.name }}</strong>
                <small>{{ match.count }} 条候选内容</small>
              </span>
              <b>进入项目搜索 →</b>
            </RouterLink>
          </div>
        </aside>
        <GraphCanvas
          v-if="graphView?.nodes.length"
          ref="graphCanvas"
          :graph="graphView"
          :selected-item="selectedItem"
          @select-node="selectNode"
          @select-edge="selectEdge"
        />
        <div v-else class="graph-empty">{{ loading ? '正在读取知识…' : '这个空间还没有可展示的关系图' }}</div>
      </div>

      <KnowledgeInspector
        :item="selectedItem"
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
      />
    </div>
    <p v-if="mode === 'graph'" class="graph-hint">滚轮缩放 · 拖动画布 · 点击查看详情 · 悬停显示节点短 ID</p>

    <KnowledgeEditDialog
      :item="editingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? spaceId"
      :personal-project-id="knowledgeMutationProjectId(editingItem)"
      :projects="store.state?.personalProjects ?? []"
      :replacement-items="allItems"
      @close="editingItem = null"
      @saved="loadGraph"
    />
    <KnowledgeConfirmDialog
      :item="confirmingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? spaceId"
      :personal-project-id="knowledgeMutationProjectId(confirmingItem)"
      @close="confirmingItem = null"
      @saved="loadGraph"
    />
    <KnowledgeProjectDialog
      :item="projectActionItem"
      :personal-space-id="store.activePersonalSpace?.id ?? spaceId"
      :personal-project-id="projectId"
      :projects="store.state?.personalProjects ?? []"
      @close="projectActionItem = null"
      @saved="completeProjectAction"
    />
    <PublishProjectDialog
      :project="publishingProject"
      @close="publishingProject = null"
      @published="loadGraph"
    />
    <PersonalProjectProfileDialog
      :project="managingProject"
      :material-type="managingMaterialType"
      @close="managingProject = null"
      @saved="completeProjectProfileUpdate"
    />
  </section>
</template>
