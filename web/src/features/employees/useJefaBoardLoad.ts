import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { ApiError, getJson, postJson } from '@/api/client'
import { fetchEmployeeCatalog, employeeErrorMessage, type EmployeeTemplate } from './catalog'
import { isEmployeeBoardItem, type EmployeeProjectBoard } from './task-board-model'

// UI waiting limits agreed in U-R1's design, not a service SLA.
const LONG_WAIT_MS = 8_000
// A load ends when no project board has answered for this long (rec#56): a large,
// steadily progressing selection finishes, a stuck one still stops.
const IDLE_BUDGET_MS = 30_000
// One project's board, with its complete list when truncated.
const READ_TIMEOUT_MS = 30_000
// Boards read at once; the rest of the selection waits its turn (rec#56).
const BOARD_CONCURRENCY = 4
export type JefaReadStage = 'console' | 'catalog' | 'board' | 'snapshot'
export interface JefaReadFailure { projectId: string; stage: JefaReadStage; category: string; at: string }
type ManagedProject = { id: string; name: string }
type BoardRead = { controller: AbortController; timer?: ReturnType<typeof setTimeout> }

const DENIED_STATUSES = [401, 403, 404]
const timeoutError = () => new DOMException('Timed out', 'TimeoutError')

export function useJefaBoardLoad(input: {
  enabled: Ref<boolean>
  spaceId: Ref<string>
  consoleError: Ref<string>
  boards: Ref<EmployeeProjectBoard[]>
  scopeValid: () => boolean
  /** The effectively selected project IDs: only their boards are read and counted. */
  selectedIds: () => string[]
  /** An open task's project: its board is read too, for the task's own access and staleness, but not counted. */
  linkedProjectId: () => string | undefined
  projectNames: Ref<Map<string, string>>
}) {
  const template = ref<EmployeeTemplate | null>(null)
  // True once a catalog read finished for this space, so a null template means
  // "read in full and Jefa is absent" rather than "not read yet".
  const catalogRead = ref(false)
  // A load (catalog or boards) is running; `loading` is what the selection still waits for.
  const running = ref(false)
  const longWait = ref(false)
  const stage = ref<JefaReadStage>('console')
  const failure = ref('')
  const projects = ref<ManagedProject[]>([])
  // The selected projects: progress, failures, content and staleness count only these.
  const scopeIds = ref<string[]>([])
  // The projects whose boards are read: the selection plus a linked task's project.
  let readScopeIds: string[] = []
  // True once this load's catalog allows board reads, so a filter change reads its new scope.
  const scopeReadable = ref(false)
  // In flight first, then queued.
  const inProgressIds = ref<string[]>([])
  // Boards read in full during this load, kept when the filter changes. Failures cover every project of this load.
  const readIds = ref<string[]>([])
  const readFailures = ref<JefaReadFailure[]>([])
  const staleIds = ref<string[]>([])
  const updatedAt = ref('')
  const timedOut = ref(false)
  let generation = 0
  let controller: AbortController | null = null
  let slowTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let readingCatalog = false
  let currentSpace = ''
  let queue: string[] = []
  const inFlight = new Map<string, BoardRead>()
  const snapshotIds = new Set<string>()
  const inScope = computed(() => new Set(scopeIds.value))
  const failures = computed(() => readFailures.value.filter(f => !f.projectId || inScope.value.has(f.projectId)))
  const loadedIds = computed(() => readIds.value.filter(id => inScope.value.has(id)))
  const stale = computed(() => staleIds.value.some(id => inScope.value.has(id)))
  const hasContent = computed(() => input.boards.value.some(b => inScope.value.has(b.project.id)))
  const pendingIds = computed(() => inProgressIds.value.filter(id => inScope.value.has(id)))
  const loading = computed(() => running.value && (!scopeReadable.value || pendingIds.value.length > 0))
  const readOnly = computed(() => loading.value || stale.value)
  // A catalog that could not be read (not a refusal): the board and its filter cannot show.
  const catalogFailed = computed(() => !running.value && readFailures.value.some(f => !f.projectId && f.stage === 'catalog'
    && !DENIED_STATUSES.some(status => f.category === `HTTP ${status}`)))
  // Whether one task's project may be written to: a task outside the selection waits only for its own board.
  function taskReadOnly(projectId: string) {
    return inScope.value.has(projectId) ? readOnly.value : inProgressIds.value.includes(projectId) || staleIds.value.includes(projectId)
  }

  function clearTimers() { clearTimeout(slowTimer); clearTimeout(idleTimer) }
  function syncPending() { inProgressIds.value = [...inFlight.keys(), ...queue] }
  function dropRead(projectId: string) {
    const read = inFlight.get(projectId)
    read?.controller.abort()
    clearTimeout(read?.timer)
    inFlight.delete(projectId)
    snapshotIds.delete(projectId)
  }
  function dropReads() {
    for (const projectId of [...inFlight.keys()]) dropRead(projectId)
    queue = []
    syncPending()
  }
  function cancel() {
    ++generation
    clearTimers()
    controller?.abort()
    dropReads()
    readingCatalog = false
    running.value = false
  }
  function current(version: number) { return running.value && version === generation }
  function addFailure(projectId: string, atStage: JefaReadStage, cause: unknown) {
    readFailures.value = [...readFailures.value.filter(f => f.projectId !== projectId), {
      projectId, stage: atStage,
      category: cause instanceof ApiError ? `HTTP ${cause.status}` : cause instanceof Error ? cause.name : 'unknown',
      at: new Date().toISOString(),
    }]
  }
  function finish() {
    clearTimers()
    running.value = false
    readingCatalog = false
    if (!failures.value.length) updatedAt.value = new Date().toISOString()
  }
  function fail(cause: unknown) {
    failure.value = employeeErrorMessage(cause)
    addFailure('', stage.value, cause)
    scopeReadable.value = false
    // A failed authorization read cannot establish the previous scope is still authorized.
    if (cause instanceof ApiError && DENIED_STATUSES.includes(cause.status)) {
      input.boards.value = []; staleIds.value = []; template.value = null; projects.value = []
    }
    dropReads()
    finish()
    controller?.abort()
  }
  // Waits at most the idle budget for the next board answer; then everything pending times out.
  function armIdleBudget(version: number) {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!current(version)) return
      timedOut.value = true
      for (const id of inProgressIds.value) addFailure(id, snapshotIds.has(id) ? 'snapshot' : 'board', timeoutError())
      if (!inProgressIds.value.length) addFailure('', stage.value, timeoutError())
      dropReads()
      finish()
      ++generation // Even transports that ignore abort must not publish late results.
      controller?.abort()
    }, IDLE_BUDGET_MS)
  }
  function start() {
    cancel()
    timedOut.value = false; longWait.value = false
    controller = new AbortController()
    running.value = true
    const version = generation
    slowTimer = setTimeout(() => { if (current(version)) longWait.value = true }, LONG_WAIT_MS)
    armIdleBudget(version)
    return version
  }
  function begin(preserve: boolean) {
    const version = start()
    failure.value = ''; readFailures.value = []; readIds.value = []; readScopeIds = []; scopeReadable.value = false
    if (!preserve) { input.boards.value = []; template.value = null; projects.value = []; scopeIds.value = []; updatedAt.value = ''; catalogRead.value = false }
    staleIds.value = input.boards.value.map(b => b.project.id)
    stage.value = input.spaceId.value ? 'catalog' : 'console'
    if (input.spaceId.value) void readCatalog(version)
  }
  function publish(board: EmployeeProjectBoard) {
    input.boards.value = [...input.boards.value.filter(b => b.project.id !== board.project.id), board]
    staleIds.value = staleIds.value.filter(id => id !== board.project.id)
  }
  // Frees a project's slot, then starts queued reads or ends the load.
  function release(projectId: string, version: number, spaceId: string) {
    dropRead(projectId)
    syncPending()
    stage.value = snapshotIds.size ? 'snapshot' : 'board'
    if (!inProgressIds.value.length) finish()
    else pump(version, spaceId)
  }
  async function readProject(project: ManagedProject, read: BoardRead, version: number, spaceId: string) {
    const live = () => current(version) && inFlight.get(project.id) === read
    const signal = read.controller.signal
    let atStage: JefaReadStage = 'board'
    try {
      const result = await postJson<EmployeeProjectBoard>('/api/employee-templates/jefa/call', {
        personalSpaceId: spaceId, personalProjectId: project.id, tool: 'read_board', arguments: { limit: 100 },
      }, { signal })
      if (!live()) return
      const board = { ...result, project, items: Array.isArray(result.items) ? result.items.filter(isEmployeeBoardItem).filter(i => i.projectId === project.id) : [] }
      publish(board) // A truncated board is still useful while its complete list loads in the same slot.
      if (result.truncated) {
        atStage = 'snapshot'; snapshotIds.add(project.id); stage.value = 'snapshot'
        const result = await getJson<{ snapshot: { workItems: unknown[] } }>(`/employee-workspaces/jefa/${encodeURIComponent(project.id)}/api/snapshot`, { signal })
        if (!live()) return
        if (!Array.isArray(result.snapshot?.workItems)) throw new Error('Invalid board snapshot')
        publish({ ...board, items: result.snapshot.workItems.filter(isEmployeeBoardItem).filter(i => i.projectId === project.id), truncated: false })
      }
      readIds.value = [...readIds.value, project.id]
    } catch (cause) {
      if (!live()) return
      addFailure(project.id, atStage, cause)
      if (cause instanceof ApiError && DENIED_STATUSES.includes(cause.status)) {
        input.boards.value = input.boards.value.filter(b => b.project.id !== project.id)
        staleIds.value = staleIds.value.filter(id => id !== project.id)
      }
    } finally {
      if (live()) {
        armIdleBudget(version) // An answer, even a refusal, is progress.
        release(project.id, version, spaceId)
      }
    }
  }
  function pump(version: number, spaceId: string) {
    while (current(version) && inFlight.size < BOARD_CONCURRENCY && queue.length) {
      const project = projects.value.find(p => p.id === queue[0])!
      queue.shift()
      const read: BoardRead = { controller: new AbortController() }
      read.timer = setTimeout(() => {
        if (!current(version) || inFlight.get(project.id) !== read) return
        timedOut.value = true
        addFailure(project.id, snapshotIds.has(project.id) ? 'snapshot' : 'board', timeoutError())
        release(project.id, version, spaceId)
      }, READ_TIMEOUT_MS)
      inFlight.set(project.id, read)
      void readProject(project, read, version, spaceId)
    }
    syncPending()
  }
  // Moves the read to the current scope: reads of projects no longer in it stop,
  // reads still in it continue, and newly added projects join the queue. Returns how many joined.
  function wantedScope() {
    const selected = new Set(input.selectedIds())
    const linked = input.linkedProjectId()
    return {
      selected: projects.value.filter(p => selected.has(p.id)).map(p => p.id),
      read: projects.value.filter(p => selected.has(p.id) || p.id === linked).map(p => p.id),
    }
  }
  function readScope(version: number, spaceId: string, previous: ReadonlySet<string>) {
    const { selected, read: scope } = wantedScope()
    const next = new Set(scope)
    scopeIds.value = selected
    readScopeIds = scope
    for (const id of [...inFlight.keys()]) if (!next.has(id)) dropRead(id)
    queue = queue.filter(id => next.has(id))
    const added = scope.filter(id => !previous.has(id) && !readIds.value.includes(id) && !inFlight.has(id) && !queue.includes(id))
    readFailures.value = readFailures.value.filter(f => !added.includes(f.projectId))
    queue.push(...added)
    syncPending()
    stage.value = snapshotIds.size ? 'snapshot' : 'board'
    if (!inProgressIds.value.length) finish()
    else pump(version, spaceId)
    return added.length
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
      armIdleBudget(version) // The catalog's answer is progress: the boards get the whole idle budget.
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
      readScope(version, spaceId, new Set())
    } catch (cause) { if (current(version)) fail(cause) }
  }
  function reload() { if (!running.value) begin(true) }
  function scopeChanged(catalog?: EmployeeTemplate | null) {
    // An already successful authority read wins even if the next network read fails.
    if (catalog !== undefined) applyCatalog(catalog)
    begin(true)
  }
  // A filter change keeps reads still selected, stops the others and queues the new ones.
  function selectionChanged() {
    if (!input.enabled.value || !scopeReadable.value || !input.spaceId.value) return
    const wanted = wantedScope()
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index])
    if (same(wanted.selected, scopeIds.value) && same(wanted.read, readScopeIds)) return
    const previous = new Set(readScopeIds)
    const continuing = running.value
    const version = continuing ? generation : start()
    // Projects the user just added get the whole idle budget, not what the old scope left.
    if (readScope(version, input.spaceId.value, previous) && continuing && current(version)) armIdleBudget(version)
  }
  watch([input.enabled, input.spaceId], ([enabled, spaceId], previous) => {
    if (!enabled) { cancel(); return }
    if (previous?.[0] && !previous[1] && spaceId) {
      currentSpace = spaceId
      if (running.value && stage.value === 'console') void readCatalog(generation)
      // A late bootstrap cannot silently replace an expired/failed read. Reload is explicit.
      if (running.value || timedOut.value || failure.value) return
    }
    const preserve = Boolean(previous?.[0] && spaceId && currentSpace === spaceId)
    currentSpace = spaceId
    begin(preserve)
  }, { immediate: true })
  watch(input.consoleError, error => { if (input.enabled.value && error && running.value && stage.value === 'console') fail(new Error(error)) }, { immediate: true })
  onBeforeUnmount(cancel)
  return {
    template, catalogRead, loading, longWait, stage, failure, failures, projects, scopeIds, pendingIds, loadedIds, stale, readOnly,
    updatedAt, timedOut, hasContent, catalogFailed,
    // A linked task's access is decided by every refusal of this load, including its own project's.
    accessFailures: readFailures, taskReadOnly, reload, scopeChanged, selectionChanged,
  }
}
