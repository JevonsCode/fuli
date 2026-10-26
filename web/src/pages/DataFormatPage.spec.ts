import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client')>(), getJson: api.getJson, postJson: api.postJson,
}))

import { ApiError } from '@/api/client'
import DataFormatPage from './DataFormatPage.vue'

const DIGEST = 'a'.repeat(64)
const plan = (digest = DIGEST) => ({
  digest,
  stores: [{
    label: 'task-schedules.sqlite', store: 'task-schedules', kind: 'sqlite', action: 'apply', automatic: [],
    step: { id: 'task-schedules/3-run-recovery', summary: 'recoverable claims', kind: 'backfill', fromVersion: 2,
      toVersion: 3, count: 12, sampleIds: ['schedule-alpha-0001#1', 's2#2'], scopeDigest: 'b'.repeat(64) },
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
    pruned: [{ kind: 'pruned', store: 'task-schedules' }, { kind: 'prune_unverified', store: 'graph' }] })
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
    expect(cards[0].text()).toContain('task-schedules/3-run-recovery')
    expect(cards[0].text()).toContain('2 → 3')
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
      { label: 'task-schedules.sqlite', status: 'applied', migrationId: 'task-schedules/3-run-recovery', count: 12 },
      { label: 'graph (personal)', status: 'already_applied', migrationId: 'graph/9-group-id-separators' }] })
    api.getJson.mockResolvedValue({ digest: null, stores: [], blocked: [], undoable: [] })
    await apply.trigger('click')
    await flushPromises()

    expect(api.postJson).toHaveBeenCalledWith('/api/data-format/apply', { digest: DIGEST })
    expect(wrapper.text()).toContain('已应用 task-schedules/3-run-recovery')
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
    expect(api.postJson).toHaveBeenLastCalledWith('/api/data-format/prune', {})
    expect(wrapper.find('[data-prune-unverified]').exists()).toBe(false)
    expect(wrapper.get('[data-prune-checked]').text()).toContain('共清理 2 份')
  })

  it('restores a whole store only after the person reads what is lost, and follows FULI through its restart', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = await mountPage()
      expect(wrapper.text()).not.toMatch(/fuli migrate|终端/)
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
      expect(api.getJson).toHaveBeenLastCalledWith('/api/data-format/restore?label=task-schedules.sqlite&backup=format-backups%2Fb1')
      expect(wrapper.get('[data-restore-impact]').text()).toContain('task_schedule_runs：现在 9 行，备份里 2 行')
      expect(wrapper.get('[data-restore-confirm]').attributes('disabled')).toBeDefined()

      await wrapper.get('#store-restore-understood').trigger('click')
      api.postJson.mockResolvedValueOnce({ id: 'r1', label: 'task-schedules.sqlite', backupRef: 'format-backups/b1',
        status: 'stopping', safetyBackupRef: null, started: null, error: null })
      await wrapper.get('[data-restore-confirm]').trigger('click')
      await flushPromises()
      expect(api.postJson).toHaveBeenLastCalledWith('/api/data-format/restore',
        { label: 'task-schedules.sqlite', backupRef: 'format-backups/b1', currentDigest: 'digest-now' })
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
      { label: 'agent-roundtable.sqlite', migrationId: 'roundtable/9-x' })
    expect(wrapper.text()).toContain('已撤销 roundtable/9-x，存储回到版本 8')
  })
})
