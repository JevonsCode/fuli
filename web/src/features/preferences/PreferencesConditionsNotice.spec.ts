import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson }))

import { knowledgeItemFromNode } from '@/features/knowledge/model'
import { setLocale } from '@/i18n'
import type { KnowledgeNode } from '@/types'

import { unstatedHabits } from './habit-conditions'
import PreferencesConditionsNotice from './PreferencesConditionsNotice.vue'
import { organizePreferencesSentence } from './preference-organizing'

// Synthetic habits and clients; nothing is read from a real preference or client.
const confirmed = { confirmation_status: 'confirmed', confirmation_state_explicit: true,
  confirmation_basis: { existence_reason: 'Said so.', quadrant_reason: 'Said so.', proposed_by: { kind: 'user' },
    confirmed_by: { kind: 'user' }, confirmed_at: '2026-11-01T00:00:00Z' } }
const habit = (id: string, fields: Partial<KnowledgeNode> = {}) => knowledgeItemFromNode({ id, name: id, type: 'Preference',
  summary: `Synthetic habit ${id}.`, profile_aspect: 'judgment_preference', ...confirmed, ...fields } as KnowledgeNode)
const link = { id: 'codex-new', opens: 'App', template: 'codex://new?prompt={prompt}', parameters: { prompt: { format: 'any' } },
  platforms: ['windows'], notes: 'Synthetic.', source: 'https://example.test/docs' }
const manifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 2, updatedAt: '2026-11-11', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link] }] }
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); setLocale('zh-CN', { persist: false }) })

describe('habits that never say when they apply', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getJson.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/client-links') return { manifest, source: 'bundled', remoteUrl: 'https://example.test', autoUpdate: false, lastCheckedAt: null, history: [] }
      if (url === '/api/system/client-connection/status') {
        return { available: true, clients: [{ id: 'codex', label: 'Codex', status: 'connected', sourceApplication: 'codex' }], customClients: [] }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    postJson.mockReset().mockResolvedValue({ launcher: 'unavailable' })
  })

  it('counts the delivered habits without a stated case, and the hard rules among them', () => {
    const items = [
      habit('plain'),
      habit('hard', { hard_rule: true }),
      habit('stated', { stated_case: 'making slide decks', hard_rule: true }),
      // Not delivered: waiting for the person, or history.
      habit('pending', { confirmation_status: 'pending', confirmation_state_explicit: false, confirmation_basis: null }),
      habit('retired', { invalid_at: '2026-11-02T00:00:00Z' }),
    ]
    expect(unstatedHabits(items)).toEqual({ count: 2, hard: 1 })
    expect(unstatedHabits(items.slice(2))).toEqual({ count: 0, hard: 0 })
  })

  it('asks the AI for that one step, in the range picked', () => {
    expect(organizePreferencesSentence('all', 'conditions')).toBe('#FLA Astro 整理我的偏好：补上何时适用')
    expect(organizePreferencesSentence('global', 'conditions')).toBe('#FLA Astro 整理我的偏好：补上何时适用，范围：个人全局')
  })

  it('says how many and hands them to a connected client; shows nothing when every habit says it', async () => {
    const wrapper = mount(PreferencesConditionsNotice, { props: { items: [habit('plain'), habit('hard', {
      hard_rule: true })], scope: 'global' }, attachTo: document.body })
    mounted.push(wrapper)
    const notice = wrapper.get('[data-preferences-conditions]')
    expect(notice.text()).toContain('没写适用情况的习惯有 2 条（其中硬性规则 1 条）')
    expect(notice.text()).not.toMatch(/fuli |npm |\$ /)
    const trigger = notice.get('[data-preferences-organize="conditions"]')
    expect(trigger.attributes('aria-label')).toBe('让 AI 来做：补上习惯何时适用')
    await trigger.trigger('click')
    await flushPromises()
    const panel = document.querySelector<HTMLElement>('[data-preferences-organize-panel]')!
    expect(panel.textContent).toContain('让 AI 补上何时适用')
    const codex = panel.querySelector<HTMLAnchorElement>('[data-new-session-open="codex"]')!
    expect(codex.href).toBe(`codex://new?prompt=${encodeURIComponent('#FLA Astro 整理我的偏好：补上何时适用，范围：个人全局')}`)
    await wrapper.setProps({ items: [habit('plain'), habit('none-hard')] })
    expect(wrapper.get('[data-preferences-conditions]').text()).toContain('没写适用情况的习惯有 2 条，每次任务都会带上')
    await wrapper.setProps({ items: [habit('stated', { stated_case: 'making slide decks' })] })
    expect(wrapper.find('[data-preferences-conditions]').exists()).toBe(false)
  })

  it('has English words too', async () => {
    setLocale('en-US', { persist: false })
    const wrapper = mount(PreferencesConditionsNotice, { props: { items: [habit('a', { hard_rule: true }),
      habit('b')], scope: 'all' } })
    mounted.push(wrapper)
    expect(wrapper.text()).toContain('2 habits never say when they apply (1 of them hard rules)')
  })
})
