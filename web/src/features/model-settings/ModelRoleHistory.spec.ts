import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), ...api }))

import { setLocale } from '@/i18n'
import ModelRoleHistory from './ModelRoleHistory.vue'
import type { HistoryEntry } from './history'

// Synthetic history entries only, as src/model-backends/settings-history.js lists them.
const ENTRIES: HistoryEntry[] = [
  { kind: 'changed_outside_console', changedAt: null, role: 'tonborg' },
  { kind: 'suggestions_only', changeId: 'c3', changedAt: '2026-10-24T09:30:00.000Z', role: 'tonborg', fromRevision: '1', toRevision: '2',
    changes: [{ field: 'suggestionsOnly', before: false, after: true }] },
  { kind: 'settings', changeId: 'c2', changedAt: '2026-10-24T09:00:00.000Z', role: 'tonborg', fromRevision: 'a'.repeat(64),
    toRevision: 'b'.repeat(64), changes: [
      { field: 'connection.model', before: 'qwen-test', after: 'qwen-next' },
      { field: 'settings.budget.maxOutputTokens', before: 400, after: 800 },
      { field: 'settings.fallbackToSession', before: false, after: true },
      { field: 'connection.secretRef', changed: true },
    ] },
  { kind: 'warning_acknowledged', changeId: 'c1', changedAt: '2026-10-24T08:00:00.000Z', role: 'tonborg', fromRevision: '0', toRevision: '1',
    changes: [{ field: 'warningVersion', before: null, after: 1 }] },
  { kind: 'earlier_changes_not_recorded', changedAt: null, role: 'tonborg' },
]

let resolveRead: (entries: HistoryEntry[]) => void = () => {}
beforeEach(() => {
  setLocale('zh-CN', { persist: false })
  api.getJson.mockReset()
  api.getJson.mockImplementation((url: string) => {
    expect(url).toBe('/api/model-backends/history?role=tonborg')
    return new Promise(resolve => { resolveRead = (entries) => resolve({ entries }) })
  })
})

const lines = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[data-model-history-entry]')
  .map(entry => [entry.attributes('data-model-history-entry'), entry.find('time').exists(), entry.findAll('li').map(line => line.text())])

describe('ModelRoleHistory', () => {
  it('stays collapsed and unread until opened, then shows a compact wait', async () => {
    const wrapper = mount(ModelRoleHistory, { props: { role: 'tonborg', revision: 'r1' } })
    expect(wrapper.get('[data-model-history-toggle]').text()).toBe('变更记录')
    expect(wrapper.get('[data-model-history-toggle]').attributes('aria-expanded')).toBe('false')
    expect(api.getJson).not.toHaveBeenCalled()

    await wrapper.get('[data-model-history-toggle]').trigger('click')
    expect(api.getJson).toHaveBeenCalledTimes(1)
    const waiting = wrapper.findAll('[role="status"]')
    expect(waiting).toHaveLength(1)
    expect(waiting[0].classes()).toContain('growth-loading--compact')
    expect(waiting[0].attributes('aria-label')).toBe('正在读取 Tonborg 的变更记录…')
  })

  it('lists changes newest first in one line each, with the two markers', async () => {
    const wrapper = mount(ModelRoleHistory, { props: { role: 'tonborg', revision: 'r1' } })
    await wrapper.get('[data-model-history-toggle]').trigger('click')
    resolveRead(ENTRIES)
    await flushPromises()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(lines(wrapper)).toEqual([
      ['marker', false, ['model-backends.json 在控制台之外改过，那些改动没有记录。']],
      ['change', true, ['执行方式改为「只给建议」']],
      ['change', true, ['模型：qwen-test → qwen-next', '单次输出 tokens：400 → 800', '失败时回到当前会话：否 → 是', '密钥引用已更换']],
      ['change', true, ['看过了执行方式的提示']],
      ['marker', false, ['更早的改动没有记录。']],
    ])
    expect(wrapper.text()).not.toContain('aaaa')
    expect(wrapper.find('time').attributes('datetime')).toBe('2026-10-24T09:30:00.000Z')
  })

  it('reads in English, and again when the role changes while open', async () => {
    setLocale('en-US', { persist: false })
    const wrapper = mount(ModelRoleHistory, { props: { role: 'tonborg', revision: 'r1' } })
    await wrapper.get('[data-model-history-toggle]').trigger('click')
    resolveRead([ENTRIES[2]])
    await flushPromises()
    expect(lines(wrapper)[0][2]).toEqual(['Model: qwen-test → qwen-next', 'Output tokens per call: 400 → 800',
      'Fall back to the current session: No → Yes', 'Key reference replaced'])

    await wrapper.setProps({ revision: 'r2' })
    expect(api.getJson).toHaveBeenCalledTimes(2)
    // The loaded list stays while it is read again, with one inline wait.
    expect(wrapper.findAll('[role="status"]').map(status => status.classes())).toEqual([expect.arrayContaining(['growth-loading--inline'])])
    expect(lines(wrapper)).toHaveLength(1)
    resolveRead([])
    await flushPromises()
    expect(wrapper.get('[data-model-history-empty]').text()).toBe('No changes recorded yet.')
  })
})
