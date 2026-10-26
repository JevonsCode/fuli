import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { ApiError, getJson, postJson } from '@/api/client'
import { fetchEmployeeCatalog, employeeErrorMessage, type EmployeeTemplate } from './catalog'
import { isEmployeeBoardItem, type EmployeeProjectBoard } from './task-board-model'

// UI waiting limits agreed in U-R1's design, not a service SLA.
const LONG_WAIT_MS = 8_000
const READ_BUDGET_MS = 30_000
// Boards read at once; the rest of the selection waits its turn (rec#56).
const BOARD_CONCURRENCY = 4
export type JefaReadStage = 'console' | 'catalog' | 'board' | 'snapshot'
export interface JefaReadFailure { projectId: string; stage: JefaReadStage; category: string; at: string }
type ManagedProject = { id: string; name: string }

export function useJefaBoardLoad(input: {
  enabled: Ref<boolean>
  spaceId: Ref<string>
  consoleError: Ref<string>
  boards: Ref<EmployeeProjectBoard[]>
  scopeValid: () => boolean
  /** The effectively selected project IDs: only their boards are read. */
  selectedIds: () => string[]
  projectNames: Ref<Map<string, string>>
}) {
  const template = ref<EmployeeTemplate | null>(null)
  // True once a catalog read finished for this space, so a null template means
  // "read in full and Jefa is absent" rather than "not read yet".
  const catalogRead = ref(false)
  const loading = ref(false)
  const longWait = ref(false)
  const stage = ref<JefaReadStage>('console')
  const failure = ref('')
  const projects = ref<ManagedProject[]>([])
  // The selected projects the current board read covers: progress, failures and staleness count only these.
  const scopeIds = ref<string[]>([])
  // True once this load's catalog allows board reads, so a filter change reads its new scope.
  const scopeReadable = ref(false)
  const pendingIds = ref<string[]>([])
  // Boards read in full during this load, reused when the filter changes. Failures cover every project of this load.
  const readIds = ref<string[]>([])
  const readFailures = ref<JefaReadFailure[]>([])
  const staleIds = ref<string[]>([])
  const updatedAt = ref('')
  const timedOut = ref(false)
  let generation = 0
  let controller: AbortController | null = null
  let slowTimer: ReturnType<typeof setTimeout> | undefined
  let budgetTimer: ReturnType<typeof setTimeout> | undefined
  let readingCatalog = false
  let currentSpace = ''
  const snapshotIds = new Set<string>()
  const inScope = computed(() => new Set(scopeIds.value))
  const failures = computed(() => readFailures.value.filter(f => !f.projectId || inScope.value.has(f.projectId)))
  const loadedIds = computed(() => readIds.value.filter(id => inScope.value.has(id)))
  const stale = computed(() => staleIds.value.some(id => inScope.value.has(id)))
  // An empty selection is a settled board too: it keeps the filter on screen.
  const hasContent = computed(() => input.boards.value.length > 0 || (scopeReadable.value && !scopeIds.value.length))
  const readOnly = computed(() => loading.value || stale.value)

  function clearTimers() { clearTimeout(slowTimer); clearTimeout(budgetTimer) }
  function cancel() {
    ++generation
    clearTimers()
    controller?.abort()
    readingCatalog = false
    loading.value = false
    snapshotIds.clear()
  }
  function current(version: number) { return loading.value && version === generation }
  function addFailure(projectId: string, atStage: JefaReadStage, cause: unknown) {
    readFailures.value = [...readFailures.value.filter(f => f.projectId !== projectId), {
      projectId, stage: atStage,
      category: cause instanceof ApiError ? `HTTP ${cause.status}` : cause instanceof Error ? cause.name : 'unknown',
      at: new Date().toISOString(),
    }]
  }
  function finish() {
    clearTimers()
    loading.value = false
    readingCatalog = false
    if (!failures.value.length) updatedAt.value = new Date().toISOString()
  }
  function fail(cause: unknown) {
    failure.value = employeeErrorMessage(cause)
    addFailure('', stage.value, cause)
    scopeReadable.value = false
    // A failed authorization read cannot establish the previous scope is still authorized.
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      input.boards.value = []; staleIds.value = []; template.value = null; projects.value = []
    }
    finish()
    controller?.abort()
  }
  // One read: its own abort signal and the whole wait budget. Returns its version.
  function start() {
    cancel()
    timedOut.value = false; longWait.value = false; pendingIds.value = []
    controller = new AbortController()
    loading.value = true
    const version = generation
    slowTimer = setTimeout(() => { if (current(version)) longWait.value = true }, LONG_WAIT_MS)
    budgetTimer = setTimeout(() => {
      if (!current(version)) return
      timedOut.value = true
      for (const id of pendingIds.value) addFailure(id, snapshotIds.has(id) ? 'snapshot' : 'board', new DOMException('Timed out', 'TimeoutError'))
      if (!pendingIds.value.length) addFailure('', stage.value, new DOMException('Timed out', 'TimeoutError'))
      pendingIds.value = []
      finish()
      ++generation // Even transports that ignore abort must not publish late results.
      controller?.abort()
    }, READ_BUDGET_MS)
    return version
  }
  function begin(preserve: boolean) {
    const version = start()
    failure.value = ''; readFailures.value = []; readIds.value = []; scopeReadable.value = false
    if (!preserve) { input.boards.value = []; template.value = null; projects.value = []; scopeIds.value = []; updatedAt.value = ''; catalogRead.value = false }
    staleIds.value = input.boards.value.map(b => b.project.id)
    stage.value = input.spaceId.value ? 'catalog' : 'console'
    if (input.spaceId.value) void readCatalog(version)
  }
  function publish(board: EmployeeProjectBoard) {
    input.boards.value = [...input.boards.value.filter(b => b.project.id !== board.project.id), board]
    staleIds.value = staleIds.value.filter(id => id !== board.project.id)
  }
  async function readProject(project: ManagedProject, version: number, spaceId: string, signal: AbortSignal) {
    let atStage: JefaReadStage = 'board'
    try {
      const result = await postJson<EmployeeProjectBoard>('/api/employee-templates/jefa/call', {
        personalSpaceId: spaceId, personalProjectId: project.id, tool: 'read_board', arguments: { limit: 100 },
      }, { signal })
      if (!current(version)) return
      const board = { ...result, project, items: Array.isArray(result.items) ? result.items.filter(isEmployeeBoardItem).filter(i => i.projectId === project.id) : [] }
      publish(board) // A truncated board is still useful while its complete snapshot loads.
      if (result.truncated) {
        atStage = 'snapshot'; snapshotIds.add(project.id); stage.value = 'snapshot'
        const result = await getJson<{ snapshot: { workItems: unknown[] } }>(`/employee-workspaces/jefa/${encodeURIComponent(project.id)}/api/snapshot`, { signal })
        if (!current(version)) return
        if (!Array.isArray(result.snapshot?.workItems)) throw new Error('Invalid board snapshot')
        publish({ ...board, items: result.snapshot.workItems.filter(isEmployeeBoardItem).filter(i => i.projectId === project.id), truncated: false })
      }
      if (current(version)) readIds.value = [...readIds.value, project.id]
    } catch (cause) {
      if (!current(version)) return
      addFailure(project.id, atStage, cause)
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
        input.boards.value = input.boards.value.filter(b => b.project.id !== project.id)
        staleIds.value = staleIds.value.filter(id => id !== project.id)
      }
    } finally {
      if (current(version)) {
        snapshotIds.delete(project.id)
        pendingIds.value = pendingIds.value.filter(id => id !== project.id)
        stage.value = snapshotIds.size ? 'snapshot' : 'board'
        if (!pendingIds.value.length) finish()
      }
    }
  }
  // Reads the selected boards this load has not read in full yet, a few at a time.
  function readScope(version: number, spaceId: string) {
    const selected = new Set(input.selectedIds())
    const scope = projects.value.filter(p => selected.has(p.id))
    scopeIds.value = scope.map(p => p.id)
    const queue = scope.filter(p => !readIds.value.includes(p.id))
    const queued = new Set(queue.map(p => p.id))
    readFailures.value = readFailures.value.filter(f => !queued.has(f.projectId))
    pendingIds.value = [...queued]
    stage.value = 'board'
    if (!queue.length) { finish(); return }
    const signal = controller!.signal
    async function worker() {
      // A filter change, the budget or a new load ends this version: the rest of its queue is never sent.
      while (current(version) && queue.length) await readProject(queue.shift()!, version, spaceId, signal)
    }
    const workers = Math.min(BOARD_CONCURRENCY, queue.length)
    for (let index = 0; index < workers; index++) void worker()
  }
  function applyCatalog(value: EmployeeTemplate | null) {
    template.value = value
    catalogRead.value = true
    projects.value = value?.managedProjects ?? (value?.assignments ?? [])
      .filter(a => a.status === 'active').map(a => ({ id: a.personalProjectId, name: input.projectNames.value.get(a.personalProjectId) ?? a.personalProjectId }))
    const allowed = new Set(value?.permissions.includes('board.read') && value.runtimeStatus === 'ready' ? projects.value.map(p => p.id) : [])
    input.boards.value = input.boards.value.filter(b => allowed.has(b.project.id))
    staleIds.value = staleIds.value.filter(id => allowed.has(id))
  }
  async function readCatalog(version: number) {
    if (!current(version) || readingCatalog || !input.spaceId.value) return
    readingCatalog = true; stage.value = 'catalog'
    const spaceId = input.spaceId.value
    const signal = controller!.signal
    try {
      const templates = await fetchEmployeeCatalog(spaceId, { signal })
      if (!current(version)) return
      applyCatalog(templates.find(t => t.id === 'jefa') ?? null)
      const value = template.value
      readingCatalog = false
      if (value && !value.permissions.includes('board.read')) {
        fail(new ApiError(JSON.stringify({ code: 'assignment_required' }), 403)); return
      }
      if (!value || value.runtimeStatus !== 'ready' || !projects.value.length) {
        input.boards.value = []; staleIds.value = []; finish(); return
      }
      await nextTick() // Let the current route's authorized filter resolve against the catalog.
      if (!current(version)) return
      if (!input.scopeValid()) { input.boards.value = []; staleIds.value = []; finish(); return }
      scopeReadable.value = true
      readScope(version, spaceId)
    } catch (cause) { if (current(version)) fail(cause) }
  }
  function reload() { if (!loading.value) begin(true) }
  function scopeChanged(catalog?: EmployeeTemplate | null) {
    // An already successful authority read wins even if the next network read fails.
    if (catalog !== undefined) applyCatalog(catalog)
    begin(true)
  }
  // A filter change cancels the old queue and reads only what the new selection still needs.
  function selectionChanged() {
    if (!input.enabled.value || !scopeReadable.value || !input.spaceId.value) return
    const selected = new Set(input.selectedIds())
    if (selected.size === scopeIds.value.length && scopeIds.value.every(id => selected.has(id))) return
    readScope(start(), input.spaceId.value)
  }
  watch([input.enabled, input.spaceId], ([enabled, spaceId], previous) => {
    if (!enabled) { cancel(); return }
    if (previous?.[0] && !previous[1] && spaceId) {
      currentSpace = spaceId
      if (loading.value && stage.value === 'console') void readCatalog(generation)
      // A late bootstrap cannot silently replace an expired/failed read. Reload is explicit.
      if (loading.value || timedOut.value || failure.value) return
    }
    const preserve = Boolean(previous?.[0] && spaceId && currentSpace === spaceId)
    currentSpace = spaceId
    begin(preserve)
  }, { immediate: true })
  watch(input.consoleError, error => { if (input.enabled.value && error && loading.value && stage.value === 'console') fail(new Error(error)) }, { immediate: true })
  onBeforeUnmount(cancel)
  return { template, catalogRead, loading, longWait, stage, failure, failures, projects, scopeIds, pendingIds, loadedIds, stale, readOnly, updatedAt, timedOut, hasContent, reload, scopeChanged, selectionChanged }
}
