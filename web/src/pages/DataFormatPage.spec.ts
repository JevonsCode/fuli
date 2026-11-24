import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, postJson: api.postJson,
}))

import { ApiError } from '@/api/client'
import { setLocale } from '@/i18n'
import DataFormatPage from './DataFormatPage.vue'

const DIGEST = 'a'.repeat(64)
const plan = (digest = DIGEST) => ({
  digest,
  stores: [{
    label: 'agent-apps/registry.sqlite', store: 'agent-apps', kind: 'sqlite', action: 'apply', automatic: [],
    step: { id: 'agent-apps/7-identity-keys', summary: 'identity keys', kind: 'backfill', fromVersion: 6,
      toVersion: 7, count: 12, sampleIds: ['schedule-alpha-0001#1', 's2#2'], scopeDigest: 'b'.repeat(64) },
    undo: 'available', digest: 'c'.repeat(64),
  }, {
    label: 'graph (personal)', store: 'graph', kind: 'neo4j', action: 'apply', automatic: [],
    step: { id: 'graph/9-group-id-separators', summary: 'group IDs', kind: 'rewrite', fromVersion: 8, toVersion: 9,
      count: 1, sampleIds: ['space-1'], scopeDigest: 'd'.repeat(64) },
    undo: 'available', digest: 'e'.repeat(64),
  }],
  blocked: [{ label: 'judgment.sqlite', store: 'judgment', action: 'blocked', steps: [],
    reason: 'written by a newer FULI (format 9)' }],
  undoable: [{ label: 'agent-roundtable.sqlite', store: 'roundtable', migrationId: 'roundtable/9-x', fromVersion: 8,
    toVersion: 9 }],
})

beforeEach(() => {
  api.getJson.mockReset()
  api.postJson.mockReset()
  api.getJson.mockResolvedValue(plan())
})

const mountPage = async () => {
  const wrapper = mount(DataFormatPage, { attachTo: document.body, global: { stubs: { RouterLink: true } } })
  await flushPromises()
  return wrapper
}

describe('DataFormatPage', () => {
  it.each([
    ['zh-CN', '已完成的迁移', '已迁移', '将从版本 9 恢复到 8'],
    ['en-US', 'Completed migrations', 'Migrated', 'Will restore version 9 to 8'],
  ] as const)('distinguishes completed migration state from undo in %s', async (locale, heading, status, direction) => {
    setLocale(locale)
    try {
      api.getJson.mockResolvedValue({ ...plan(), stores: [], blocked: [] })
      const wrapper = await mountPage()
      expect(wrapper.get('#data-format-completed').text()).toBe(heading)
      const row = wrapper.get('[data-completed-migration]')
      expect(row.text()).toContain(status)
      expect(row.text()).toContain('8 → 9')
      expect(row.text()).not.toContain('9 → 8')
      expect(wrapper.find('[data-undo-details]').exists()).toBe(false)
      expect(api.postJson).not.toHaveBeenCalled()

      await row.get('[data-undo]').trigger('click')
      expect(wrapper.get('[data-undo-details]').text()).toContain(direction)
      expect(api.postJson).not.toHaveBeenCalled()
      await wrapper.get('[data-cancel-undo]').trigger('click')
      expect(wrapper.find('[data-undo-details]').exists()).toBe(false)
      expect(row.text()).toContain(status)
      expect(api.postJson).not.toHaveBeenCalled()
      wrapper.unmount()
    } finally {
      setLocale('zh-CN')
    }
  })

  it('lets the person close the current completion reminders without hiding future migrations', async () => {
    const id = 'a'.repeat(64)
    api.getJson.mockResolvedValue({ ...plan(), notice: { active: [{ id,
      migrationId: 'graph/12-builtin-occupations', remaining: 6 }] } })
    api.postJson.mockResolvedValue({ notice: { active: [] } })
    const wrapper = await mountPage()

    expect(wrapper.get('[data-format-completed-notice]').text()).toContain('graph/12-builtin-occupations')
    expect(wrapper.get('[data-format-completed-notice]').text()).toContain('剩余 6 次')
    await wrapper.get('[data-dismiss-format-notices]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/data-format/dismiss-notices', { ids: [id] }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.find('[data-format-completed-notice]').exists()).toBe(false)
    expect(wrapper.findAll('[data-store-plan]')).toHaveLength(2)
  })

  it('keeps the reminder visible if dismissing it fails', async () => {
    api.getJson.mockResolvedValue({ ...plan(), notice: { active: [{ id: 'a'.repeat(64),
      migrationId: 'graph/12-builtin-occupations', remaining: 6 }] } })
    api.postJson.mockRejectedValue(new Error('disk refused'))
    const wrapper = await mountPage()
    await wrapper.get('[data-dismiss-format-notices]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-format-completed-notice]').text()).toContain('graph/12-builtin-occupations')
    expect(wrapper.get('[role="alert"]').text()).toContain('disk refused')
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-format-completed-notice]').exists()).toBe(true)
  })

  it('closes only the chosen reminder when several migrations are shown', async () => {
    const first = { id: 'a'.repeat(64), migrationId: 'graph/12-example', remaining: 6 }
    const second = { id: 'b'.repeat(64), migrationId: 'graph/13-example', remaining: 4 }
    api.getJson.mockResolvedValue({ ...plan(), notice: { active: [first, second] } })
    api.postJson.mockResolvedValue({ notice: { active: [second] } })
    const wrapper = await mountPage()
    const notices = wrapper.findAll('[data-format-completed-notice]')
    expect(notices).toHaveLength(2)
    await notices[0].get('[data-dismiss-format-notices]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenCalledWith('/api/data-format/dismiss-notices', { ids: [first.id] }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.findAll('[data-format-completed-notice]')).toHaveLength(1)
    expect(wrapper.get('[data-format-completed-notice]').text()).toContain(second.migrationId)
  })

  it('says what a deleting step loses before the confirm control', async () => {
    const restoreOnly = plan()
    restoreOnly.stores[1] = { ...restoreOnly.stores[1], undo: 'restore_only',
      warning: 'deletes the older duplicate learning-cache projections; the undo journal cannot restore deleted records (2 records deleted)' } as never
    api.getJson.mockResolvedValue(restoreOnly)
    const wrapper = await mountPage()

    expect(wrapper.get('[data-store-warning]').text()).toContain('cannot restore deleted records')
    const confirm = wrapper.get('.data-format-confirm')
    const warning = confirm.get('[data-confirm-warnings]')
    expect(warning.text()).toContain('graph (personal)')
    expect(warning.text()).toContain('2 records deleted')
    const order = warning.element.compareDocumentPosition(confirm.get('#data-format-reviewed').element)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.text()).toContain('不能单独撤销，只能整库恢复')
  })

  it('offers 先备份图谱 before the confirm control, only when a graph step waits, and says where the backup went', async () => {
    vi.useFakeTimers()
    try {
      const running = { id: 'j1', action: 'backup', status: 'running', step: null, version: 9, error: null, started: null,
        backup: { name: 'before-format-9-t', path: '/data/backups/graph/before-format-9-t', createdAt: '2026-11-24T08:00:00.000Z', bytes: 2048 } }
      let job: Record<string, unknown> | null = null
      api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
        ? { latest: null, room: { bytes: 2048, freeBytes: 1_000_000 }, job } : plan())
      const wrapper = await mountPage()
      const confirm = wrapper.get('.data-format-confirm')
      const backup = confirm.get('[data-graph-backup]')
      expect(backup.text()).toContain('确认后撤销如果被拒绝，只有它能把图谱带回确认前')
      expect(backup.text()).toContain('备份时 FULI 会暂停一会儿，完成后自动回来')
      expect(api.getJson).toHaveBeenCalledWith('/api/data-format/graph-backup?version=9', expect.anything())
      const order = backup.element.compareDocumentPosition(confirm.get('[data-apply]').element)
      expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(wrapper.text()).not.toMatch(/fuli graph|终端/)

      api.postJson.mockResolvedValue(running)
      await backup.get('[data-graph-backup-start]').trigger('click')
      await flushPromises()
      expect(api.postJson).toHaveBeenCalledWith('/api/data-format/graph-backup', { version: 9 }, expect.anything())
      expect(backup.get('[data-graph-backup-running]').text()).toContain('正在准备备份图谱')
      job = { ...running, step: 'exporting' }
      await vi.advanceTimersByTimeAsync(3000)
      expect(backup.get('[data-graph-backup-running]').text()).toContain('正在导出图谱，完成后 FULI 自动回来')
      job = { ...running, status: 'done', started: true, beforeConfirmation: true }
      await vi.advanceTimersByTimeAsync(3000)
      await flushPromises()
      expect(backup.get('[data-graph-backup-done]').text()).toContain('已备份到 /data/backups/graph/before-format-9-t')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }

    const sqliteOnly = plan()
    sqliteOnly.stores = [sqliteOnly.stores[0]]
    api.getJson.mockResolvedValue(sqliteOnly)
    const other = await mountPage()
    expect(other.find('[data-graph-backup]').exists()).toBe(false)
    other.unmount()
  })

  it('a backup already taken shows its time and size, and the button backs up again', async () => {
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest: { name: 'before-format-9-t', path: '/data/backups/graph/before-format-9-t', createdAt: '2026-11-24T08:00:00.000Z', bytes: 2048 },
        room: { bytes: null, freeBytes: 1_000_000 }, job: null } : plan())
    const wrapper = await mountPage()
    const backup = wrapper.get('[data-graph-backup]')
    expect(backup.get('[data-graph-backup-latest]').text()).toContain('已备份：')
    expect(backup.get('[data-graph-backup-start]').text()).toBe('再备份一次')
    expect(backup.text()).toContain('图谱多大导出后才知道')
    // From another computer: where to do it instead, never a retry that cannot work.
    api.postJson.mockRejectedValue(new ApiError('remote', 403, JSON.stringify({ code: 'local_user_only' })))
    await backup.get('[data-graph-backup-start]').trigger('click')
    await flushPromises()
    expect(backup.get('[data-graph-backup-refused]').text()).toContain('只能在运行 FULI 的那台电脑上做')
    // Too little room: said in the page's words, with a retry.
    api.postJson.mockRejectedValue(new ApiError('room', 409, JSON.stringify({ code: 'graph_backup_no_space', error: 'The disk cannot hold the graph export' })))
    await backup.get('[data-graph-backup-start]').trigger('click')
    await flushPromises()
    expect(backup.get('[data-graph-backup-refused]').text()).toContain('没有开始备份：磁盘放不下这次备份，没有停 FULI；腾出空间后再试。')
    wrapper.unmount()
  })

  it('a graph undo refused because records changed since offers the backup from before the confirmation, confirmed first', async () => {
    const graphUndo = { label: 'graph (personal)', store: 'graph', migrationId: 'graph/9-x', fromVersion: 8, toVersion: 9 }
    const latest = { name: 'before-format-9-t', path: '/data/backups/graph/before-format-9-t', createdAt: '2026-11-24T08:00:00.000Z', bytes: 2048 }
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest, room: { bytes: null, freeBytes: null }, job: null } : { ...plan(), stores: [], undoable: [graphUndo] })
    const wrapper = await mountPage()
    api.postJson.mockRejectedValueOnce(new ApiError('changed', 409, JSON.stringify({ code: 'data_format_changed_since', error: '2 records changed after migration' })))
    await wrapper.get('[data-undo]').trigger('click')
    await wrapper.get('[data-confirm-undo]').trigger('click')
    await flushPromises()
    const offer = wrapper.get('[data-graph-restore-offer]')
    expect(offer.text()).toContain('撤销被拒绝：确认后这些记录又改过')
    expect(offer.text()).toContain('确认前的备份：')
    expect(wrapper.text()).not.toContain('2 records changed')
    await offer.get('[data-graph-restore-open]').trigger('click')
    const start = wrapper.get('[data-graph-restore-start]')
    expect(start.attributes('disabled')).toBeDefined()
    await wrapper.get('#graph-restore-understood').trigger('click')
    api.postJson.mockResolvedValue({ id: 'r1', action: 'restore', status: 'running', step: 'stopping', version: 9, backup: latest, error: null, started: null })
    await wrapper.get('[data-graph-restore-start]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenLastCalledWith('/api/data-format/graph-backup/restore', { version: 9, name: 'before-format-9-t' }, expect.anything())
    expect(wrapper.get('[data-graph-restore-running]').text()).toContain('正在暂停 FULI，恢复完会自动回来')
    wrapper.unmount()
  })

  it('without a backup from before the confirmation, a refused graph undo says so and points to the other old data', async () => {
    const graphUndo = { label: 'graph (personal)', store: 'graph', migrationId: 'graph/9-x', fromVersion: 8, toVersion: 9 }
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest: null, room: { bytes: null, freeBytes: null }, job: null } : { ...plan(), stores: [], undoable: [graphUndo] })
    const wrapper = await mountPage()
    api.postJson.mockRejectedValueOnce(new ApiError('changed', 409, JSON.stringify({ code: 'data_format_changed_since', error: 'x' })))
    await wrapper.get('[data-undo]').trigger('click')
    await wrapper.get('[data-confirm-undo]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-restore-offer]').text()).toContain('确认前没有用「先备份图谱」留下备份')
    expect(wrapper.find('[data-graph-restore-others]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('a backup refused because the step was confirmed elsewhere reads the plan again and no longer offers it', async () => {
    let confirmed = false
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest: null, room: { bytes: null, freeBytes: null }, job: null }
      : confirmed ? { ...plan(), stores: [plan().stores[0]] } : plan())
    const wrapper = await mountPage()
    confirmed = true
    // Being confirmed, or the graph unreadable: said as such, with a retry, and the plan is not read again for it.
    const getCalls = api.getJson.mock.calls.length
    api.postJson.mockRejectedValueOnce(new ApiError('changing', 409, JSON.stringify({ code: 'graph_format_changing', error: 'x' })))
    await wrapper.get('[data-graph-backup-start]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-backup-refused]').text()).toContain('没有开始备份：正在确认或撤销这一步，完成后再看。')
    api.postJson.mockRejectedValueOnce(new ApiError('unreadable', 409, JSON.stringify({ code: 'graph_format_unreadable', error: 'x' })))
    await wrapper.get('[data-graph-backup-start]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-backup-refused]').text()).toContain('现在读不到图谱的状态，所以没有备份；等 FULI 恢复后再点')
    expect(wrapper.get('[data-graph-backup-refused]').find('button').exists()).toBe(true)
    expect(api.getJson.mock.calls.length).toBe(getCalls)
    expect(wrapper.text()).not.toContain('图谱这一步已经确认过了')
    api.postJson.mockRejectedValue(new ApiError('confirmed', 409, JSON.stringify({ code: 'graph_backup_confirmed', error: 'no longer waits' })))
    await wrapper.get('[data-graph-backup-start]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-graph-backup]').exists()).toBe(false)
    expect(wrapper.text()).toContain('图谱这一步已经确认过了，现在备份的不是确认前的数据，所以没有备份')
    expect(wrapper.text()).toContain('用「已完成的迁移」里的撤销')
    wrapper.unmount()
  })

  it('holds the confirmation back while a graph backup runs, and words a confirmation the server refused for one', async () => {
    const running = { id: 'j1', action: 'backup', status: 'running', step: 'exporting', version: 9, error: null, started: null, backup: null }
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest: null, room: { bytes: null, freeBytes: null }, job: running } : plan())
    const wrapper = await mountPage()
    // A backup another tab started is followed, and the confirm and undo controls wait for it.
    expect(wrapper.get('[data-graph-backup-running]').text()).toContain('正在导出图谱')
    await wrapper.get('#data-format-reviewed').trigger('click')
    expect(wrapper.get('[data-apply]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-undo]').attributes('disabled')).toBeDefined()
    wrapper.unmount()

    // Started from another window just before this click: the server refuses it, said in the page's words.
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest: null, room: { bytes: null, freeBytes: null }, job: null } : plan())
    const other = await mountPage()
    await other.get('#data-format-reviewed').trigger('click')
    api.postJson.mockRejectedValue(new ApiError('busy', 409, JSON.stringify({ code: 'graph_backup_running', error: 'The graph is being backed up' })))
    await other.get('[data-apply]').trigger('click')
    await flushPromises()
    expect(other.text()).toContain('正在备份或恢复图谱，FULI 暂停着；完成后再点。')
    expect(other.text()).not.toContain('The graph is being backed up')
    other.unmount()
  })

  it('a backup whose step was confirmed while it was exported, or not checked, is said to be no way back, with the old data linked', async () => {
    vi.useFakeTimers()
    try {
      const running = { id: 'j1', action: 'backup', status: 'running', step: 'exporting', version: 9, error: null, started: null,
        backup: { name: 'before-format-9-t', path: '/data/backups/graph/before-format-9-t', createdAt: '2026-11-24T08:00:00.000Z', bytes: 2048 } }
      let job: Record<string, unknown> = running
      api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
        ? { latest: null, room: { bytes: null, freeBytes: null }, job } : plan())
      const wrapper = await mountPage()
      job = { ...running, step: 'checking' }
      await vi.advanceTimersByTimeAsync(3000)
      expect(wrapper.get('[data-graph-backup-running]').text()).toContain('正在核对这份备份是不是确认前的')
      job = { ...running, status: 'done', step: null, started: true, beforeConfirmation: false }
      await vi.advanceTimersByTimeAsync(3000)
      await flushPromises()
      const notice = wrapper.get('[data-graph-backup-not-before]')
      expect(notice.text()).toContain('它不是确认前的备份，不能用来回到确认前。这份备份仍在「旧数据」里。')
      expect(notice.find('[data-graph-backup-old-data]').exists()).toBe(true)
      expect(wrapper.find('[data-graph-backup-done]').exists()).toBe(false)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second tab asking for the same backup follows the one that runs', async () => {
    api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
      ? { latest: null, room: { bytes: null, freeBytes: null }, job: null } : plan())
    const wrapper = await mountPage()
    api.postJson.mockResolvedValue({ id: 'j1', action: 'backup', status: 'running', step: 'stopping', version: 9, error: null, started: null, backup: null, joined: true })
    await wrapper.get('[data-graph-backup-start]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-graph-backup-running]').text()).toContain('正在暂停 FULI')
    expect(wrapper.get('[data-graph-backup-joined]').text()).toBe('另一个窗口已经在备份了，这里接着显示那一次的进度。')
    wrapper.unmount()
  })

  it('a restore whose import stopped half way, with FULI refusing to start, says where to go and asks again on request', async () => {
    vi.useFakeTimers()
    try {
      const graphUndo = { label: 'graph (personal)', store: 'graph', migrationId: 'graph/9-x', fromVersion: 8, toVersion: 9 }
      const latest = { name: 'before-format-9-t', path: '/data/backups/graph/before-format-9-t', createdAt: '2026-11-24T08:00:00.000Z', bytes: 2048 }
      let down = false
      api.getJson.mockImplementation(async (url: string) => {
        if (down) throw new TypeError('Failed to fetch')
        return url.startsWith('/api/data-format/graph-backup')
          ? { latest, room: { bytes: null, freeBytes: null }, job: null } : { ...plan(), stores: [], undoable: [graphUndo] }
      })
      const wrapper = await mountPage()
      api.postJson.mockRejectedValueOnce(new ApiError('changed', 409, JSON.stringify({ code: 'data_format_changed_since', error: 'x' })))
      await wrapper.get('[data-undo]').trigger('click')
      await wrapper.get('[data-confirm-undo]').trigger('click')
      await flushPromises()
      await wrapper.get('[data-graph-restore-open]').trigger('click')
      expect(wrapper.get('[data-graph-restore-local]').text()).toContain('指向之后新建的项目或知识的记录会找不到')
      expect(wrapper.get('[data-graph-restore-older]').text()).toBe('没有「确认前」记录的旧备份不在这里，可以在「旧数据」里看到。')
      expect(wrapper.find('[data-graph-restore-others]').exists()).toBe(true)
      await wrapper.get('#graph-restore-understood').trigger('click')
      api.postJson.mockResolvedValue({ id: 'r1', action: 'restore', status: 'running', step: 'restoring', version: 9, backup: latest, error: null, started: null })
      await wrapper.get('[data-graph-restore-start]').trigger('click')
      await flushPromises()
      // The undo waits while the restore runs.
      expect(wrapper.get('[data-undo]').attributes('disabled')).toBeDefined()
      down = true
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 3000)
      await flushPromises()
      const notice = wrapper.get('[data-graph-restore-not-back]')
      expect(notice.text()).toContain('FULI 还没有回来。打开 FULI 应用，它会重新启动；启动被拒时，窗口里会给出处理办法。')
      expect(wrapper.find('[data-graph-restore-running]').exists()).toBe(false)

      // Back after the person dealt with it: the failure is said, never a restore that did not happen.
      down = false
      api.getJson.mockImplementation(async (url: string) => url.startsWith('/api/data-format/graph-backup')
        ? { latest, room: { bytes: null, freeBytes: null }, job: { id: 'r1', action: 'restore', status: 'failed', step: null, version: 9, backup: latest,
          error: 'The graph import stopped half way', started: false } } : { ...plan(), stores: [], undoable: [graphUndo] })
      await notice.get('button').trigger('click')
      await vi.advanceTimersByTimeAsync(3000)
      await flushPromises()
      expect(wrapper.get('[data-graph-restore-failed]').text()).toContain('没有恢复：The graph import stopped half way')
      expect(wrapper.text()).not.toContain('已用')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says who must be stopped before the apply and undo controls', async () => {
    const wrapper = await mountPage()
    const notices = wrapper.findAll('[data-external-writers]')
    expect(notices).toHaveLength(2)
    expect(notices[0].text()).toContain('Neo4j 客户端、cypher-shell')
    const confirm = wrapper.get('.data-format-confirm')
    const order = confirm.get('[data-external-writers]').element.compareDocumentPosition(confirm.get('#data-format-reviewed').element)
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const undo = notices[1].element.compareDocumentPosition(wrapper.get('[data-undo]').element)
    expect(undo & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says the one retention budget backups and graph undo journals share, with the policy in force', async () => {
    api.getJson.mockResolvedValue({ ...plan(), retention: { keep: 5, maxBytes: 64 * 1024 * 1024 } })
    const wrapper = await mountPage()
    const text = wrapper.get('[data-retention]').text()
    expect(text).toContain('每个存储保留最近 5 份格式备份，图谱保留最近 5 份撤销日志；备份和日志合计最多约 64 MB')
    expect(text).toContain('即使因此超出预算')
  })

  it('says a graph prune whose answer never came is unverified, after an apply and after an undo', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-prune-unverified]').exists()).toBe(false)
    api.postJson.mockResolvedValueOnce({ status: 'applied', skipped: [], results: [{ label: 'graph (personal)',
      status: 'applied', migrationId: 'graph/9-group-id-separators' }],
    pruned: [{ kind: 'pruned', store: 'agent-apps' }, { kind: 'prune_unverified', store: 'graph' }] })
    await wrapper.get('#data-format-reviewed').trigger('click')
    await wrapper.get('[data-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-prune-unverified]').text()).toContain('图谱撤销日志的清理结果未经确认')

    api.postJson.mockResolvedValueOnce({ status: 'rolled_back', version: 8, pruned: [{ kind: 'pruned' }] })
    await wrapper.get('[data-undo]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-confirm-undo]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-prune-unverified]').exists()).toBe(false)
  })

  it('says how many unreadable records a step left, and how many later records an undo filled in', async () => {
    const wrapper = await mountPage()
    api.postJson.mockResolvedValueOnce({ status: 'applied', skipped: [], results: [{ label: 'graph (personal)',
      status: 'applied', migrationId: 'graph/9-group-id-separators', unreadable: 2 }] })
    await wrapper.get('#data-format-reviewed').trigger('click')
    await wrapper.get('[data-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-result="applied"]').text()).toContain('另有 2 条记录读不懂，原样留下。')

    api.postJson.mockResolvedValueOnce({ status: 'rolled_back', version: 8, adapted: 3 })
    await wrapper.get('[data-undo]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-confirm-undo]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('另有 3 条之后写入的记录按旧版本的格式补齐')
  })

  it('keeps the unverified prune and says the audit log write failed', async () => {
    const wrapper = await mountPage()
    api.postJson.mockResolvedValueOnce({ status: 'applied', skipped: [], results: [{ label: 'graph (personal)',
      status: 'applied', migrationId: 'graph/9-group-id-separators' }],
    pruned: [{ kind: 'prune_unverified', store: 'graph', auditError: { code: 'EISDIR', message: 'disk refused' } }] })
    await wrapper.get('#data-format-reviewed').trigger('click')
    await wrapper.get('[data-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-prune-unverified]').exists()).toBe(true)
    expect(wrapper.get('[data-audit-failed]').text()).toContain('没有写成：disk refused')
    expect(wrapper.find('[data-result="applied"]').exists()).toBe(true)
  })

  it('leaves the budget out when the server could not read the policy', async () => {
    const wrapper = await mountPage()
    expect(wrapper.find('[data-retention]').exists()).toBe(false)
  })

  it('lists each store with its step, count and sample IDs, and applies only after review', async () => {
    const wrapper = await mountPage()
    const cards = wrapper.findAll('[data-store-plan]')
    expect(cards).toHaveLength(2)
    expect(cards[0].text()).toContain('agent-apps/7-identity-keys')
    expect(cards[0].text()).toContain('6 → 7')
    expect(cards[0].text()).toContain('12 条')
    expect(cards[0].text()).toContain('另 10 条')
    expect(cards[0].find('[title="schedule-alpha-0001#1"]').exists()).toBe(true)
    expect(cards[1].text()).toContain('图谱内记录撤销日志')
    expect(wrapper.text()).toContain('written by a newer FULI')
    expect(wrapper.get('[data-plan-digest]').attributes('title')).toBe(DIGEST)

    const apply = wrapper.get('[data-apply]')
    expect(apply.attributes('disabled')).toBeDefined()
    await wrapper.get('#data-format-reviewed').trigger('click')
    expect(apply.attributes('disabled')).toBeUndefined()

    api.postJson.mockResolvedValue({ status: 'applied', skipped: [], results: [
      { label: 'agent-apps/registry.sqlite', status: 'applied', migrationId: 'agent-apps/7-identity-keys', count: 12 },
      { label: 'graph (personal)', status: 'already_applied', migrationId: 'graph/9-group-id-separators' }] })
    api.getJson.mockResolvedValue({ digest: null, stores: [], blocked: [], undoable: [] })
    await apply.trigger('click')
    await flushPromises()

    expect(api.postJson).toHaveBeenCalledWith('/api/data-format/apply', { digest: DIGEST }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.text()).toContain('已应用 agent-apps/7-identity-keys')
    expect(wrapper.text()).toContain('已由另一次确认应用 graph/9-group-id-separators')
    expect(wrapper.text()).toContain('没有等待确认的数据格式迁移')
  })

  it('reads a stale plan again and asks for a new confirmation', async () => {
    const wrapper = await mountPage()
    await wrapper.get('#data-format-reviewed').trigger('click')
    api.postJson.mockRejectedValue(new ApiError('stale', 409,
      JSON.stringify({ code: 'data_format_stale_preview', error: 'changed' })))
    api.getJson.mockResolvedValue(plan('f'.repeat(64)))
    await wrapper.get('[data-apply]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('计划在你确认后有了变化，没有做任何修改')
    expect(wrapper.get('[data-plan-digest]').attributes('title')).toBe('f'.repeat(64))
    expect(wrapper.get('[data-apply]').attributes('disabled')).toBeDefined()
  })

  it('checks an unverified prune with a button instead of a command', async () => {
    const wrapper = await mountPage()
    api.postJson.mockResolvedValueOnce({ status: 'applied', skipped: [], results: [],
      pruned: [{ kind: 'prune_unverified', store: 'graph' }] })
    await wrapper.get('#data-format-reviewed').trigger('click')
    await wrapper.get('[data-apply]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-prune-unverified]').text()).not.toMatch(/fuli |终端/)

    api.postJson.mockResolvedValueOnce({ pruned: [{ kind: 'pruned', store: 'graph' }, { kind: 'pruned', store: 'graph' }] })
    await wrapper.get('[data-prune-check]').trigger('click')
    await flushPromises()
    expect(api.postJson).toHaveBeenLastCalledWith('/api/data-format/prune', {}, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.find('[data-prune-unverified]').exists()).toBe(false)
    expect(wrapper.get('[data-prune-checked]').text()).toContain('共清理 2 份')
  })

  it('restores a whole store only after the person reads what is lost, and follows FULI through its restart', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = await mountPage()
      // Only the graph's pre-confirm export is a terminal command; no restore is.
      const outsideGraphBackup = wrapper.text().replace(wrapper.get('[data-graph-backup]').text(), '')
      expect(outsideGraphBackup).not.toMatch(/fuli migrate|终端/)
      api.getJson.mockResolvedValueOnce({ restore: null, stores: [{ label: 'task-schedules.sqlite', store: 'task-schedules',
        kind: 'sqlite', backups: [{ ref: 'format-backups/b1', version: 2, takenAt: '2026-10-01T08:00:00.000Z' }] }] })
      await wrapper.get('[data-restore-open]').trigger('click')
      await flushPromises()
      await wrapper.get('[data-restore-backup] button').trigger('click')
      api.getJson.mockResolvedValueOnce({ impact: { store: 'task-schedules', backupRef: 'format-backups/b1',
        takenAt: '2026-10-01T08:00:00.000Z', currentVersion: 3, backupVersion: 2, currentDigest: 'digest-now',
        tables: [{ table: 'task_schedule_runs', current: 9, backup: 2 }], laterMigrations: [] } })
      await wrapper.get('[data-restore-describe]').trigger('click')
      await flushPromises()
      expect(api.getJson).toHaveBeenLastCalledWith('/api/data-format/restore?label=task-schedules.sqlite&backup=format-backups%2Fb1', expect.objectContaining({ schema: expect.anything() }))
      expect(wrapper.get('[data-restore-impact]').text()).toContain('task_schedule_runs：现在 9 行，备份里 2 行')
      expect(wrapper.get('[data-restore-confirm]').attributes('disabled')).toBeDefined()

      await wrapper.get('#store-restore-understood').trigger('click')
      api.postJson.mockResolvedValueOnce({ id: 'r1', label: 'task-schedules.sqlite', backupRef: 'format-backups/b1',
        status: 'stopping', safetyBackupRef: null, started: null, error: null })
      await wrapper.get('[data-restore-confirm]').trigger('click')
      await flushPromises()
      expect(api.postJson).toHaveBeenLastCalledWith('/api/data-format/restore',
        { label: 'task-schedules.sqlite', backupRef: 'format-backups/b1', currentDigest: 'digest-now' }, expect.objectContaining({ schema: expect.anything() }))
      expect(wrapper.text()).toContain('正在停止 FULI 并恢复「task-schedules.sqlite」')

      // FULI is down: the read fails, and the page keeps asking.
      api.getJson.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      await vi.advanceTimersByTimeAsync(2000)
      api.getJson.mockResolvedValueOnce({ restore: { id: 'r1', label: 'task-schedules.sqlite', backupRef: 'format-backups/b1',
        status: 'restored', safetyBackupRef: 'format-backups/safety', started: true, error: null } })
      api.getJson.mockResolvedValue(plan())
      await vi.advanceTimersByTimeAsync(2000)
      await flushPromises()
      expect(wrapper.get('[data-restore-outcome="restored"]').text())
        .toContain('已用备份 format-backups/b1 恢复「task-schedules.sqlite」。恢复前的存储另存为 format-backups/safety。')
    } finally {
      vi.useRealTimers()
    }
  })

  it('undoes one migration only after a second, explicit confirmation', async () => {
    const wrapper = await mountPage()
    await wrapper.get('[data-undo]').trigger('click')
    expect(api.postJson).not.toHaveBeenCalled()
    api.postJson.mockResolvedValue({ status: 'rolled_back', version: 8 })
    await wrapper.get('[data-confirm-undo]').trigger('click')
    await flushPromises()

    expect(api.postJson).toHaveBeenCalledWith('/api/data-format/rollback',
      { label: 'agent-roundtable.sqlite', migrationId: 'roundtable/9-x' }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.text()).toContain('已撤销 roundtable/9-x，存储回到版本 8')
  })

  it('says what graph/23 changes in the person\'s words, and keeps a step it does not know as the Provider wrote it', async () => {
    setLocale('zh-CN')
    const temporaryNames = { ...plan(), stores: [{ ...plan().stores[1]!, step: { ...plan().stores[1]!.step,
      id: 'graph/23-temporary-project-names', summary: 'a temporary project stores no name', fromVersion: 22, toVersion: 23, count: 259 } },
    plan().stores[0]!] }
    api.getJson.mockResolvedValue(temporaryNames)
    const wrapper = await mountPage()
    const [graph, other] = wrapper.findAll('[data-step-description]')
    expect(graph!.text()).toContain('临时项目 #编号')
    expect(graph!.text()).toContain('你起过名的项目不动')
    expect(graph!.text()).toContain('撤销')
    expect(other!.text()).toBe('identity keys')
    expect(wrapper.get('[data-store-plan]').text()).toContain('259')
    wrapper.unmount()
  })
})
