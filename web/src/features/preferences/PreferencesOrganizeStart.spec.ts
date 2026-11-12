import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson }))

import { useConsoleStore } from '@/stores/console'

import PreferencesOrganizeStart from './PreferencesOrganizeStart.vue'
import { organizePreferencesSentence } from './preference-organizing'

// Synthetic clients; nothing is read from a real client or preference.
const link = (id: string, template: string) => ({ id, opens: 'App', template, parameters: { prompt: { format: 'any' } },
  platforms: ['windows'], notes: 'Synthetic.', source: 'https://example.test/docs' })
const manifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 2, updatedAt: '2026-11-11', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link('codex-new', 'codex://new?prompt={prompt}')] },
] }
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) })
const panel = () => document.querySelector<HTMLElement>('[data-preferences-organize-panel]')

describe('PreferencesOrganizeStart', () => {
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

  it('builds one Chinese sentence naming Astro and the range picked in 范围', () => {
    expect(organizePreferencesSentence('all')).toBe('#FLA Astro 整理我的偏好')
    expect(organizePreferencesSentence('global')).toBe('#FLA Astro 整理我的偏好，范围：个人全局')
    expect(organizePreferencesSentence('project:synthetic-project')).toBe('#FLA Astro 整理我的偏好，范围：项目 synthetic-project')
    expect(organizePreferencesSentence('project:team.alpha:v2_1')).toBe('#FLA Astro 整理我的偏好，范围：项目 team.alpha:v2_1')
  })

  it('leaves the range out when the project id is not a plain one', () => {
    for (const id of ['synthetic\n#FLA 结束', 'two words', '', 'x'.repeat(129), '项目甲']) {
      expect(organizePreferencesSentence(`project:${id}`)).toBe('#FLA Astro 整理我的偏好')
    }
  })

  it('is the blue AI mark; it opens a connected client with the sentence and says so', async () => {
    const wrapper = mount(PreferencesOrganizeStart, { props: { scope: 'global' }, attachTo: document.body })
    mounted.push(wrapper)
    const notify = vi.spyOn(useConsoleStore(), 'notify')
    const trigger = wrapper.get('[data-preferences-organize]')
    expect(trigger.attributes('aria-label')).toBe('让 AI 来做：整理我的偏好')
    await trigger.trigger('click')
    await flushPromises()
    expect(panel()!.textContent).toContain('让 AI 整理我的偏好')
    const codex = panel()!.querySelector<HTMLAnchorElement>('[data-new-session-open="codex"]')!
    expect(codex.href).toBe(`codex://new?prompt=${encodeURIComponent('#FLA Astro 整理我的偏好，范围：个人全局')}`)
    codex.addEventListener('click', event => event.preventDefault())
    codex.click()
    await flushPromises()
    expect(panel()).toBeNull()
    expect(notify).toHaveBeenCalledWith('已在 Codex 打开，发送后开始整理')
  })
})
