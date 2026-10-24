import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import ModelRoleHistory from './ModelRoleHistory.vue'
import type { HistoryEntry } from './history'

// Synthetic history entries only, as src/model-backends/settings-history.js lists them.
const SETTINGS: HistoryEntry = { kind: 'settings', changeId: 'c2', changedAt: '2026-10-24T09:00:00.000Z', role: 'tonborg',
  fromRevision: 'a'.repeat(64), toRevision: 'b'.repeat(64), via: null, changes: [
    { field: 'connection.model', before: 'qwen-test', after: 'qwen-next' },
    { field: 'settings.budget.maxOutputTokens', before: 400, after: 800 },
    { field: 'settings.fallbackToSession', before: false, after: true },
    { field: 'connection.secretRef', changed: true },
  ] }
const ENTRIES: HistoryEntry[] = [
  { kind: 'unrecorded_changes', changedAt: null, role: 'tonborg' },
  { kind: 'suggestions_only', changeId: 'c3', changedAt: '2026-10-24T09:30:00.000Z', role: 'tonborg', fromRevision: '1', toRevision: '2',
    via: null, changes: [{ field: 'suggestionsOnly', before: false, after: true }] },
  SETTINGS,
  { kind: 'unrecorded_gap', changedAt: null, role: 'tonborg' },
  { kind: 'settings', changeId: 'c4', changedAt: '2026-10-24T08:30:00.000Z', role: 'tonborg', fromRevision: 'c'.repeat(64),
    toRevision: 'a'.repeat(64), via: 'bole', changes: [{ field: 'connection.model', before: 'qwen-old', after: 'qwen-test' }] },
  { kind: 'warning_acknowledged', changeId: 'c1', changedAt: '2026-10-24T08:00:00.000Z', role: 'tonborg', fromRevision: '0', toRevision: '1',
    via: null, changes: [{ field: 'warningVersion', before: null, after: 1 }] },
  { kind: 'earlier_changes_not_recorded', changedAt: null, role: 'tonborg' },
]

// Each read waits until the test answers or fails it, in any order.
let reads: { resolve: (entries: HistoryEntry[]) => void; reject: (error: Error) => void }[] = []
beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  reads = []
  api.getJson.mockReset()
  api.getJson.mockImplementation((url: string) => {
    expect(url).toBe('/api/model-backends/history?role=tonborg')
    return new Promise((resolve, reject) => { reads.push({ resolve: entries => resolve({ entries }), reject }) })
  })
})

const lines = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-model-history-entry]')
  .map(entry => [entry.attributes('data-model-history-entry'), entry.find('time').exists(), entry.findAll('li').map(line => line.text())])
const section = (version = 1) => mount(ModelRoleHistory, { props: { role: 'tonborg', version } })
const toggle = (wrapper: ReturnType<typeof mount>) => wrapper.get('[data-model-history-toggle]').trigger('click')

describe('ModelRoleHistory', () => {
  it('stays collapsed and unread until opened, then shows a compact wait', async () => {
    const wrapper = section()
    expect(wrapper.get('[data-model-history-toggle]').text()).toBe('变更记录')
    expect(wrapper.get('[data-model-history-toggle]').attributes('aria-expanded')).toBe('false')
    expect(api.getJson).not.toHaveBeenCalled()

    await toggle(wrapper)
    expect(api.getJson).toHaveBeenCalledTimes(1)
    const waiting = wrapper.findAll('[role="status"]')
    expect(waiting).toHaveLength(1)
    expect(waiting[0].classes()).toContain('growth-loading--compact')
    expect(waiting[0].attributes('aria-label')).toBe('正在读取 Tonborg 的变更记录…')
  })

  it('lists changes newest first in one line each, the role a change came through, and the three markers', async () => {
    const wrapper = section()
    await toggle(wrapper)
    reads[0].resolve(ENTRIES)
    await flushPromises()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(lines(wrapper)).toEqual([
      ['marker', false, ['当前设置与最后一条记录不一致，有修改没有记录下来。']],
      ['change', true, ['执行方式改为「只给建议」']],
      ['change', true, ['模型：qwen-test → qwen-next', '单次输出 tokens：400 → 800', '失败时回到当前会话：否 → 是', '密钥引用已更换']],
      // A break between two records does not speak of the current settings.
      ['marker', false, ['这里有修改没有记录下来。']],
      ['change', true, ['通过 Bole 的设置修改', '模型：qwen-old → qwen-test']],
      ['change', true, ['看过了执行方式的提示']],
      ['marker', false, ['更早的改动没有记录。']],
    ])
    expect(wrapper.text()).not.toContain('aaaa')
    expect(wrapper.find('time').attributes('datetime')).toBe('2026-10-24T09:30:00.000Z')
  })

  it('reads in English, and again when the role changes while open', async () => {
    setLocale('en-US', { persist: false })
    const wrapper = section()
    await toggle(wrapper)
    reads[0].resolve([SETTINGS, ENTRIES[4]])
    await flushPromises()
    expect(lines(wrapper).map(line => line[2])).toEqual([
      ['Model: qwen-test → qwen-next', 'Output tokens per call: 400 → 800', 'Fall back to the current session: No → Yes', 'Key reference replaced'],
      ['Changed through Bole\'s settings', 'Model: qwen-old → qwen-test'],
    ])

    await wrapper.setProps({ version: 2 })
    expect(api.getJson).toHaveBeenCalledTimes(2)
    // The loaded list stays while it is read again, with one inline wait.
    expect(wrapper.findAll('[role="status"]').map(status => status.classes())).toEqual([expect.arrayContaining(['growth-loading--inline'])])
    expect(lines(wrapper)).toHaveLength(2)
    reads[1].resolve([])
    await flushPromises()
    expect(wrapper.get('[data-model-history-empty]').text()).toBe('No changes recorded yet.')
  })

  it('reads again on every reopening, also after a change saved and undone while it was closed', async () => {
    const wrapper = section()
    await toggle(wrapper)
    reads[0].resolve([SETTINGS])
    await flushPromises()
    await toggle(wrapper)
    // Saved and saved back: the settings hash is the same again, the page's version is not.
    await wrapper.setProps({ version: 2 })
    await wrapper.setProps({ version: 3 })
    expect(api.getJson).toHaveBeenCalledTimes(1)
    await toggle(wrapper)
    expect(api.getJson).toHaveBeenCalledTimes(2)
    reads[1].resolve([ENTRIES[1], SETTINGS, ENTRIES[4]])
    await flushPromises()
    expect(lines(wrapper)).toHaveLength(3)
    // Nothing saved here, and still read again: another tab may have changed it.
    await toggle(wrapper)
    await toggle(wrapper)
    expect(api.getJson).toHaveBeenCalledTimes(3)
  })

  it('drops a read still in flight when the version changes while closed, and reads the new one on reopening', async () => {
    const wrapper = section()
    await toggle(wrapper)
    await toggle(wrapper)
    await wrapper.setProps({ version: 2 })
    await toggle(wrapper)
    expect(api.getJson).toHaveBeenCalledTimes(2)
    reads[0].resolve([SETTINGS])
    await flushPromises()
    expect(lines(wrapper)).toHaveLength(0)
    reads[1].resolve([ENTRIES[1], SETTINGS])
    await flushPromises()
    expect(lines(wrapper).map(line => (line[2] as string[])[0])).toEqual(['执行方式改为「只给建议」', '模型：qwen-test → qwen-next'])
    expect(api.getJson).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('lets only the latest read land, so an older answer cannot replace a newer one', async () => {
    const wrapper = section()
    await toggle(wrapper)
    await wrapper.setProps({ version: 2 })
    expect(reads).toHaveLength(2)
    reads[1].resolve([ENTRIES[1], SETTINGS])
    await flushPromises()
    reads[0].resolve([])
    await flushPromises()
    expect(lines(wrapper)).toHaveLength(2)
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
  })

  it('keeps the list when a refresh fails, says so, and retries', async () => {
    const wrapper = section()
    await toggle(wrapper)
    reads[0].resolve([SETTINGS])
    await flushPromises()
    await wrapper.setProps({ version: 2 })
    reads[1].reject(new Error('synthetic refresh failure'))
    await flushPromises()
    expect(lines(wrapper)).toHaveLength(1)
    const note = wrapper.get('[data-model-history-refresh-failed]')
    expect(note.text()).toContain('变更记录没有刷新成功')
    await note.get('button').trigger('click')
    expect(api.getJson).toHaveBeenCalledTimes(3)
    reads[2].resolve([ENTRIES[1], SETTINGS])
    await flushPromises()
    expect(wrapper.find('[data-model-history-refresh-failed]').exists()).toBe(false)
    expect(lines(wrapper)).toHaveLength(2)
  })
})
