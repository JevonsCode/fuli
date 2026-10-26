import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { getJson, patchJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, patchJson, postJson }))
import { ApiError } from '@/api/client'
import { mountEmployeeWorkbench as setup, resetEmployeeWorkbench, unmountEmployeeWorkbenches } from '@/test-support/employee-workbench'
import EmployeeTaskBoard from '@/features/employees/EmployeeTaskBoard.vue'
import EmployeeTaskDialog from '@/features/employees/EmployeeTaskDialog.vue'
import { projectBoardFilterKey } from '@/features/employees/project-board-filter'

beforeEach(() => resetEmployeeWorkbench({ getJson, patchJson, postJson }))
afterEach(() => { unmountEmployeeWorkbenches(); vi.useRealTimers() })

// rec#56: a large synthetic catalog with a small selection reads only the selection.
describe('Jefa reads only the selected projects', () => {
  const CATALOG_SIZE = 285
  const ids = Array.from({ length: CATALOG_SIZE }, (_, index) => `synthetic-${String(index + 1).padStart(3, '0')}`)
  const pick = (...indexes: number[]) => indexes.map(index => ids[index]!)
  type Wrapper = Awaited<ReturnType<typeof setup>>
  type BoardCall = { id: string; signal?: AbortSignal; resolve: (value: unknown) => void; reject: (cause: unknown) => void }
  beforeEach(() => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].managedProjects = ids.map((id, index) => ({ id, name: `合成项目 ${index + 1}` }))
      return result
    })
  })
  function saveFilter(projectIds: string[]) {
    localStorage.setItem(projectBoardFilterKey('space-a'), JSON.stringify({ version: 1, projectIds }))
  }
  const deepLink = (projectIds: string[]) => `/employees/jefa?${projectIds.map(id => `project=${id}`).join('&')}`
  function boardOf(id: string, title = `任务 ${id}`, truncated = false) {
    return { items: [{ id: `t-${id}`, projectId: id, title, status: 'planned' }], total: truncated ? 200 : 1, truncated }
  }
  function answerBoards(answer: (id: string) => unknown = id => boardOf(id)) {
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string }) => answer(body.personalProjectId))
  }
  function heldBoards() {
    const calls: BoardCall[] = []
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }, init?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      calls.push({ id: body.personalProjectId, signal: init?.signal, resolve, reject })
    }))
    return calls
  }
  const boardReads = () => postJson.mock.calls.filter(([, body]) => body.tool === 'read_board').map(([, body]) => body.personalProjectId as string)
  const status = (wrapper: Wrapper) => wrapper.get('.jefa-read-status').text()
  const board = (wrapper: Wrapper) => wrapper.getComponent(EmployeeTaskBoard)
  async function selectProjects(wrapper: Wrapper, projectIds: string[]) {
    board(wrapper).vm.$emit('update:visible-project-ids', projectIds)
    await flushPromises()
  }
  async function refresh(wrapper: Wrapper) {
    board(wrapper).vm.$emit('retry')
    await flushPromises()
  }

  it('reads only a saved filter selection, not the whole catalog', async () => {
    const selected = pick(3, 100, 200)
    saveFilter(selected)
    answerBoards()
    const wrapper = await setup('/employees/jefa')
    expect(boardReads()).toEqual(selected)
    expect(wrapper.get('.project-scope-trigger').text()).toContain(`已选 3 / 共 ${CATALOG_SIZE} 个项目`)
    for (const id of selected) expect(wrapper.text()).toContain(`任务 ${id}`)
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
  })

  it('reads a deep link with several projects four at a time, counting only that scope', async () => {
    const selected = pick(10, 20, 30, 40, 50, 60)
    const calls = heldBoards()
    const wrapper = await setup(deepLink(selected))
    expect(wrapper.vm.$route.query.project).toEqual(selected)
    expect(calls.map(call => call.id)).toEqual(selected.slice(0, 4))
    expect(status(wrapper)).toContain('已显示 0/6 个项目；6 个仍在读取，0 个读取失败')
    calls[0]!.resolve(boardOf(selected[0]!)); await flushPromises()
    expect(calls.map(call => call.id)).toEqual(selected.slice(0, 5))
    expect(status(wrapper)).toContain('已显示 1/6 个项目；5 个仍在读取')
    for (const call of calls.slice(1)) call.resolve(boardOf(call.id))
    await flushPromises()
    for (const call of calls.slice(5)) call.resolve(boardOf(call.id))
    await flushPromises()
    expect(boardReads()).toEqual(selected)
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    for (const id of selected) expect(wrapper.text()).toContain(`任务 ${id}`)
  })

  it('keeps queued projects unsent and pending while four reads are in flight', async () => {
    const selected = pick(0, 1, 2, 3, 4, 5, 6, 7, 8)
    const calls = heldBoards()
    const wrapper = await setup(deepLink(selected))
    expect(calls.map(call => call.id)).toEqual(selected.slice(0, 4))
    calls[1]!.reject(new ApiError('unavailable', 503)); await flushPromises()
    expect(calls.map(call => call.id)).toEqual(selected.slice(0, 5))
    expect(status(wrapper)).toContain('已显示 0/9 个项目；8 个仍在读取，1 个读取失败')
    expect(wrapper.find('.growth-loading').exists()).toBe(true)
  })

  it('sends no board request for an empty selection, ends loading and keeps the filter', async () => {
    saveFilter([])
    answerBoards()
    const wrapper = await setup('/employees/jefa')
    expect(boardReads()).toEqual([])
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
    expect(wrapper.get('.project-scope-trigger').text()).toContain(`已选 0 / 共 ${CATALOG_SIZE} 个项目`)
    expect(wrapper.text()).toContain('没有显示任何项目')
    expect(wrapper.vm.$route.query.empty).toBe('1')
  })

  it('cancels the old queue on a filter switch and sends nothing more for it', async () => {
    const before = pick(0, 1, 2, 3, 4, 5, 6, 7)
    const after = pick(200, 201)
    const calls = heldBoards()
    const wrapper = await setup(deepLink(before))
    calls[0]!.resolve(boardOf(before[0]!)); await flushPromises()
    expect(calls).toHaveLength(5)
    await selectProjects(wrapper, after)
    const old = calls.slice(1, 5)
    expect(old.every(call => call.signal?.aborted)).toBe(true)
    expect(calls.slice(5).map(call => call.id)).toEqual(after)
    for (const call of old) call.resolve(boardOf(call.id))
    await flushPromises()
    expect(boardReads()).toEqual([...before.slice(0, 5), ...after])
    expect(status(wrapper)).toContain('已显示 0/2 个项目；2 个仍在读取')
    for (const call of calls.slice(5)) call.resolve(boardOf(call.id))
    await flushPromises()
    expect(boardReads()).toEqual([...before.slice(0, 5), ...after])
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    expect(board(wrapper).props('canMoveTasks')).toBe(true)
  })

  it('does not let a late response from the old scope finish or feed the new one, and reuses finished boards', async () => {
    const [first, second, third] = pick(7, 70, 170) as [string, string, string]
    const calls = heldBoards()
    const call = (id: string) => calls.find(entry => entry.id === id)!
    const wrapper = await setup(deepLink([first, second]))
    call(second).resolve(boardOf(second)); await flushPromises()
    await selectProjects(wrapper, [second, third])
    expect(calls.map(entry => entry.id)).toEqual([first, second, third])
    call(first).resolve(boardOf(first, '旧范围晚到任务')); await flushPromises()
    expect(wrapper.find('.growth-loading').exists()).toBe(true)
    expect(status(wrapper)).toContain('已显示 1/2 个项目；1 个仍在读取')
    call(third).resolve(boardOf(third)); await flushPromises()
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    await selectProjects(wrapper, [first, second, third])
    // The late answer was never accepted, so only that project is read again.
    expect(calls.map(entry => entry.id)).toEqual([first, second, third, first])
    expect(wrapper.text()).not.toContain('旧范围晚到任务')
    calls[3]!.resolve(boardOf(first)); await flushPromises()
    expect(wrapper.text()).toContain(`任务 ${first}`)
    expect(wrapper.text()).not.toContain('旧范围晚到任务')
  })

  it('keeps reads still selected when the filter widens, and shows the filter before any board loads', async () => {
    const selected = pick(0, 1, 2, 3, 4)
    const calls = heldBoards()
    const wrapper = await setup(deepLink(selected))
    expect(board(wrapper).props('boards')).toEqual([])
    expect(wrapper.get('.project-scope-trigger').text()).toContain(`已选 5 / 共 ${CATALOG_SIZE} 个项目`)
    await selectProjects(wrapper, [...selected, ids[5]!])
    expect(boardReads()).toEqual(selected.slice(0, 4))
    expect(calls.some(call => call.signal?.aborted)).toBe(false)
    expect(status(wrapper)).toContain('已显示 0/6 个项目；6 个仍在读取')
    while (calls.length) {
      for (const call of calls.splice(0)) call.resolve(boardOf(call.id))
      await flushPromises()
    }
    expect(boardReads()).toEqual([...selected, ids[5]])
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
  })

  it('drops queued projects unchecked one at a time without re-sending reads still selected', async () => {
    const selected = pick(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)
    const calls = heldBoards()
    const wrapper = await setup(deepLink(selected))
    let remaining = [...selected]
    for (const unchecked of selected.slice(4, 8)) {
      remaining = remaining.filter(id => id !== unchecked)
      await selectProjects(wrapper, remaining)
    }
    expect(boardReads()).toHaveLength(4)
    expect(calls.some(call => call.signal?.aborted)).toBe(false)
    expect(status(wrapper)).toContain('已显示 0/8 个项目；8 个仍在读取')
    while (calls.length) {
      for (const call of calls.splice(0)) call.resolve(boardOf(call.id))
      await flushPromises()
    }
    expect(boardReads()).toEqual([...selected.slice(0, 4), ...selected.slice(8)])
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
  })

  it('keeps the board and its filter when every selected board fails, so the scope can change', async () => {
    const [broken, working] = pick(30, 31) as [string, string]
    answerBoards(id => id === broken ? Promise.reject(new ApiError('unavailable', 503)) : boardOf(id))
    const wrapper = await setup(deepLink([broken]))
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取失败')
    expect(wrapper.get('[role="alert"]').text()).toContain('合成项目 31')
    expect(wrapper.get('.project-scope-trigger').text()).toContain(`已选 1 / 共 ${CATALOG_SIZE} 个项目`)
    expect(board(wrapper).props('incomplete')).toBe(true)
    await selectProjects(wrapper, [working])
    expect(boardReads()).toEqual([broken, working])
    expect(wrapper.text()).toContain(`任务 ${working}`)
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
  })

  it('keeps a saved empty selection and its filter on screen while the catalog re-reads and after it fails', async () => {
    saveFilter([])
    answerBoards()
    const wrapper = await setup('/employees/jefa')
    const original = getJson.getMockImplementation()!
    let failCatalog!: (cause: unknown) => void
    getJson.mockImplementation((url: string) => url.startsWith('/api/employee-templates?')
      ? new Promise((_resolve, reject) => { failCatalog = reject }) : original(url))
    await refresh(wrapper)
    expect(wrapper.get('.project-scope-trigger').text()).toContain(`已选 0 / 共 ${CATALOG_SIZE} 个项目`)
    failCatalog(new ApiError('down', 500)); await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.get('.project-scope-trigger').text()).toContain(`已选 0 / 共 ${CATALOG_SIZE} 个项目`)
    expect(wrapper.find('.jefa-read-clear-filter').exists()).toBe(false)
    expect(boardReads()).toEqual([])
  })

  it('offers to clear a saved filter when the catalog has never loaded', async () => {
    saveFilter(pick(4))
    answerBoards()
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/employee-templates?')) throw new ApiError('down', 500)
      return original(url)
    })
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.findComponent(EmployeeTaskBoard).exists()).toBe(false)
    await wrapper.get('[role="alert"] .jefa-read-clear-filter').trigger('click'); await flushPromises()
    expect(localStorage.getItem(projectBoardFilterKey('space-a'))).toBeNull()
    expect(wrapper.vm.$route.query.project).toBe('all')
    expect(wrapper.find('.jefa-read-clear-filter').exists()).toBe(false)
  })

  it('offers to clear a saved filter after a catalog timeout too', async () => {
    vi.useFakeTimers()
    saveFilter(pick(4))
    getJson.mockImplementation(() => new Promise(() => {}))
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(30000)
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
    expect(wrapper.find('[role="alert"] .jefa-read-clear-filter').exists()).toBe(true)
  })

  it('does not offer to clear a saved filter when access is refused', async () => {
    saveFilter(pick(4))
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/employee-templates?')) result.templates[0].permissions = []
      return result
    })
    const wrapper = await setup('/employees/jefa')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.find('.jefa-read-clear-filter').exists()).toBe(false)
    expect(boardReads()).toEqual([])
  })

  it('keeps a truncated board in its slot while its complete list loads', async () => {
    const selected = pick(0, 1, 2, 3, 4, 5)
    answerBoards(id => boardOf(id, `任务 ${id}`, true))
    const original = getJson.getMockImplementation()!
    const snapshots: Array<(value: unknown) => void> = []
    getJson.mockImplementation((url: string) => url.endsWith('/api/snapshot')
      ? new Promise(resolve => { snapshots.push(resolve) }) : original(url))
    const wrapper = await setup(deepLink(selected))
    // Four boards answered and four complete lists in flight: the slots stay full.
    expect(boardReads()).toEqual(selected.slice(0, 4))
    expect(snapshots).toHaveLength(4)
    expect(status(wrapper)).toContain('已显示 0/6 个项目；6 个仍在读取')
    snapshots[0]!({ snapshot: { workItems: [] } }); await flushPromises()
    expect(boardReads()).toEqual(selected.slice(0, 5))
  })

  it('removes only the refused board on a 401 and keeps the others', async () => {
    const [kept, refused] = pick(40, 41) as [string, string]
    answerBoards(id => id === refused ? Promise.reject(new ApiError('unauthorized', 401)) : boardOf(id))
    const wrapper = await setup(deepLink([kept, refused]))
    expect(board(wrapper).props('boards').map(entry => entry.project.id)).toEqual([kept])
    expect(wrapper.get('[role="alert"]').text()).toContain('部分项目暂不可用')
    expect(wrapper.get('.jefa-read-details').text()).toContain('HTTP 401')
  })

  it('reads every project on select-all, finishing a slow but steady catalog without a timeout', async () => {
    vi.useFakeTimers()
    let open = 0
    let most = 0
    postJson.mockImplementation((_url: string, body: { personalProjectId: string }) => {
      most = Math.max(most, ++open)
      // Empty boards keep 285 rerenders cheap; the test is about pacing, not cards.
      return new Promise(resolve => setTimeout(() => { open--; resolve({ project: { id: body.personalProjectId }, items: [], total: 0, truncated: false }) }, 500))
    })
    const wrapper = await setup('/employees/jefa')
    await vi.advanceTimersByTimeAsync(Math.ceil(CATALOG_SIZE / 4) * 500 + 1000)
    expect(boardReads()).toHaveLength(CATALOG_SIZE)
    expect(new Set(boardReads()).size).toBe(CATALOG_SIZE)
    expect(most).toBe(4)
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(board(wrapper).props('readOnly')).toBe(false)
  })

  it('gives projects added by a switch the whole idle budget', async () => {
    vi.useFakeTimers()
    const [first, second] = pick(60, 61) as [string, string]
    heldBoards()
    const wrapper = await setup(deepLink([first]))
    await vi.advanceTimersByTimeAsync(20000)
    await selectProjects(wrapper, [second])
    await vi.advanceTimersByTimeAsync(20000)
    expect(wrapper.find('.growth-loading').exists()).toBe(true)
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
    expect(status(wrapper)).toContain('已显示 0/1 个项目；0 个仍在读取，1 个读取失败')
    expect(boardReads()).toEqual([first, second])
  })

  it('reads the board of a linked task outside the selection, and closes it when access is refused', async () => {
    const [selected, linked] = pick(70, 71) as [string, string]
    saveFilter([selected])
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string; arguments?: { workItemId?: string } }) => {
      if (body.tool === 'get_task') return { item: { id: body.arguments?.workItemId, projectId: body.personalProjectId, title: '链接任务', summary: '合成详情', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } }
      if (body.personalProjectId === linked) throw new ApiError('forbidden', 403)
      return boardOf(body.personalProjectId)
    })
    const wrapper = await setup(`/employees/jefa?item=space-a%2F${linked}%253At1`)
    expect(boardReads()).toEqual([selected, linked])
    expect(wrapper.getComponent(EmployeeTaskDialog).props('open')).toBe(false)
    expect(wrapper.vm.$route.query.item).toBeUndefined()
  })

  it('keeps a linked task project out of the selection status, gating only its own dialog', async () => {
    const [selected, linked] = pick(80, 81) as [string, string]
    saveFilter([selected])
    let linkedBoard: () => Promise<unknown> = async () => boardOf(linked)
    let holdLinked!: (value: unknown) => void
    postJson.mockImplementation(async (_url: string, body: { personalProjectId: string; tool: string; arguments?: { workItemId?: string } }) => {
      if (body.tool === 'get_task') return { item: { id: body.arguments?.workItemId, projectId: body.personalProjectId, title: '链接任务', summary: '合成详情', status: 'planned', updatedAt: '2026-10-18T17:00:00Z' } }
      return body.personalProjectId === linked ? linkedBoard() : boardOf(body.personalProjectId)
    })
    const dialog = (wrapper: Wrapper) => wrapper.getComponent(EmployeeTaskDialog)
    linkedBoard = () => new Promise(resolve => { holdLinked = resolve })
    const wrapper = await setup(`/employees/jefa?item=space-a%2F${linked}%253At1`)
    expect(boardReads()).toEqual([selected, linked])
    // Waiting for the linked board shows nothing in the selection's status and keeps the board editable.
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
    expect(board(wrapper).props('canMoveTasks')).toBe(true)
    expect(dialog(wrapper).props('canWrite')).toBe(false)
    holdLinked(boardOf(linked)); await flushPromises()
    expect(dialog(wrapper).props('canWrite')).toBe(true)
    // A failed refresh of the linked board makes only its own dialog read-only.
    linkedBoard = () => Promise.reject(new ApiError('unavailable', 503))
    await refresh(wrapper)
    expect(boardReads()).toEqual([selected, linked, selected, linked])
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
    expect(board(wrapper).props('readOnly')).toBe(false)
    expect(dialog(wrapper).props('open')).toBe(true)
    expect(dialog(wrapper).props('canWrite')).toBe(false)
  })

  it('reports a partial failure only while the failed project is in scope', async () => {
    const [ok, failing, other] = pick(5, 50, 150) as [string, string, string]
    answerBoards(id => id === failing ? Promise.reject(new ApiError('unavailable', 503)) : boardOf(id))
    const wrapper = await setup(deepLink([ok, failing, other]))
    expect(boardReads()).toEqual([ok, failing, other])
    expect(wrapper.get('[role="alert"]').text()).toContain('部分项目暂不可用')
    expect(status(wrapper)).toContain('已显示 2/3 个项目；0 个仍在读取，1 个读取失败')
    expect(wrapper.text()).toContain(`任务 ${ok}`)
    await selectProjects(wrapper, [ok, other])
    expect(boardReads()).toEqual([ok, failing, other])
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
    expect(board(wrapper).props('incomplete')).toBe(false)
  })

  it('keeps stale and read-only state to the current scope', async () => {
    const [kept, flaky] = pick(9, 99) as [string, string]
    answerBoards()
    const wrapper = await setup(deepLink([kept, flaky]))
    answerBoards(id => id === flaky ? Promise.reject(new ApiError('unavailable', 503)) : boardOf(id))
    await refresh(wrapper)
    expect(boardReads()).toEqual([kept, flaky, kept, flaky])
    expect(board(wrapper).props('readOnly')).toBe(true)
    await selectProjects(wrapper, [kept])
    expect(boardReads()).toHaveLength(4)
    expect(board(wrapper).props('readOnly')).toBe(false)
    expect(board(wrapper).props('canMoveTasks')).toBe(true)
  })

  it('times out only the selected scope and sends no queued request after the budget', async () => {
    vi.useFakeTimers()
    const selected = pick(1, 11, 21, 31, 41, 51)
    heldBoards()
    const wrapper = await setup(deepLink(selected))
    await vi.advanceTimersByTimeAsync(30000)
    expect(wrapper.get('[role="alert"]').text()).toContain('任务看板读取超时')
    expect(status(wrapper)).toContain('已显示 0/6 个项目；0 个仍在读取，6 个读取失败')
    await vi.advanceTimersByTimeAsync(30000)
    expect(boardReads()).toEqual(selected.slice(0, 4))
  })

  it('reads the complete list only for a selected truncated board, and a refresh re-reads only the selection', async () => {
    const [truncated, plain] = pick(12, 120) as [string, string]
    answerBoards(id => boardOf(id, `任务 ${id}`, id === truncated))
    const snapshotUrl = `/employee-workspaces/jefa/${truncated}/api/snapshot`
    const original = getJson.getMockImplementation()!
    let snapshotAvailable = false
    getJson.mockImplementation((url: string) => !url.endsWith('/api/snapshot') ? original(url)
      : snapshotAvailable && url === snapshotUrl
        ? Promise.resolve({ snapshot: { workItems: [{ id: 'full', projectId: truncated, title: '完整列表任务', status: 'planned' }] } })
        : Promise.reject(new ApiError('unavailable', 503)))
    const snapshots = () => getJson.mock.calls.map(([url]) => String(url)).filter(url => url.endsWith('/api/snapshot'))
    const wrapper = await setup(deepLink([truncated, plain]))
    expect(snapshots()).toEqual([snapshotUrl])
    expect(wrapper.get('[role="alert"]').text()).toContain('部分项目暂不可用')
    snapshotAvailable = true
    await wrapper.get('.jefa-read-actions button').trigger('click'); await flushPromises()
    expect(boardReads()).toEqual([truncated, plain, truncated, plain])
    expect(snapshots()).toEqual([snapshotUrl, snapshotUrl])
    expect(wrapper.text()).toContain('完整列表任务')
    expect(wrapper.find('.jefa-read-status').exists()).toBe(false)
  })

  it('drops a selected project whose access is revoked on refresh, without reading unselected ones', async () => {
    const [kept, revoked, other] = pick(2, 22, 222) as [string, string, string]
    answerBoards(id => boardOf(id, id === revoked ? '将撤权的合成任务' : `任务 ${id}`))
    const wrapper = await setup(deepLink([kept, revoked, other]))
    expect(wrapper.text()).toContain('将撤权的合成任务')
    answerBoards(id => id === revoked ? Promise.reject(new ApiError('forbidden', 403)) : boardOf(id))
    await refresh(wrapper)
    expect(boardReads()).toEqual([kept, revoked, other, kept, revoked, other])
    expect(wrapper.text()).not.toContain('将撤权的合成任务')
    expect(wrapper.text()).toContain(`任务 ${kept}`)
    expect(board(wrapper).props('readOnly')).toBe(false)
  })
})
