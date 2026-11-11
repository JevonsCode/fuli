import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), getJson, postJson }))
vi.mock('./project-organizing', async importOriginal => ({ ...await importOriginal<typeof import('./project-organizing')>(),
  readProjectOrganizing: vi.fn() }))

import ProjectOrganizing from './ProjectOrganizing.vue'
import { organizeSentence, readProjectOrganizing, type ProjectOrganizingState } from './project-organizing'

// Synthetic coverage; nothing is read from a real project or client.
const AREAS = ['purpose', 'stack', 'run'].map(id => ({ id, zh: `合成 ${id}`, en: `Synthetic ${id}`, status: 'missing' }))
const state = (extra: Partial<ProjectOrganizingState> = {}): ProjectOrganizingState => ({ started: false, areas: AREAS,
  progress: { settled: 0, total: 9, complete: false }, runs: [], ...extra })
const link = (id: string, template: string) => ({ id, opens: 'App', template, parameters: { prompt: { format: 'any' } },
  platforms: ['windows'], notes: 'Synthetic.', source: 'https://example.test/docs' })
const manifest = { format: 'fuli-client-links', formatVersion: 1, manifestVersion: 2, updatedAt: '2026-11-11', clients: [
  { id: 'codex', name: 'Codex', noSessionLink: null, sessionLinks: [link('codex-new', 'codex://new?prompt={prompt}')] },
  { id: 'opencode', name: 'OpenCode', noSessionLink: 'Synthetic: no link.', sessionLinks: [] },
] }
const client = (id: string, label: string, sourceApplication: string, status = 'connected') => ({ id, label, status, sourceApplication })
let clients: ReturnType<typeof client>[] = []

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()) })
const mountCard = async () => {
  const wrapper = mount(ProjectOrganizing, { props: { spaceId: 'synthetic-space', projectId: 'synthetic-project' }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const panel = () => document.querySelector<HTMLElement>('[data-organizing-panel]')
async function openPanel(wrapper: ReturnType<typeof mount>) {
  await wrapper.get('[data-organizing-start]').trigger('click')
  await flushPromises()
  return panel()!
}

describe('ProjectOrganizing', () => {
  const writeText = vi.fn()
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(readProjectOrganizing).mockReset()
    writeText.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    clients = [client('codex', 'Codex', 'codex'), client('opencode', 'OpenCode', 'opencode'), client('cursor', 'Cursor', 'cursor', 'not_connected')]
    getJson.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/client-links') return { manifest, source: 'bundled', remoteUrl: 'https://example.test', autoUpdate: false, lastCheckedAt: null, history: [] }
      if (url === '/api/system/client-connection/status') return { available: true, clients, customClients: [] }
      throw new Error(`Unexpected request: ${url}`)
    })
    postJson.mockReset().mockResolvedValue({ launcher: 'unavailable' })
  })

  it('builds one Chinese sentence naming Astro, the project and, when given, where the material is', () => {
    expect(organizeSentence({ projectId: 'synthetic-project' })).toBe('#FLA Astro 整理项目 synthetic-project')
    expect(organizeSentence({ projectId: 'synthetic-project', material: '   ' })).toBe('#FLA Astro 整理项目 synthetic-project')
    expect(organizeSentence({ projectId: 'p', material: '  docs/a,\n  https://example.test/b ' })).toBe('#FLA Astro 整理项目 p，资料在 docs/a, https://example.test/b')
    expect(organizeSentence({ projectId: 'p', material: 'x'.repeat(600) })).toBe(`#FLA Astro 整理项目 p，资料在 ${'x'.repeat(500)}`)
  })

  it('says a project was never organised; 整理 lists the connected clients and opens one with the sentence', async () => {
    vi.mocked(readProjectOrganizing).mockResolvedValue(state())
    const wrapper = await mountCard()
    expect(readProjectOrganizing).toHaveBeenCalledWith('synthetic-space', 'synthetic-project', expect.anything())
    expect(wrapper.get('[data-organizing-progress]').text()).toBe('还没整理过')
    expect(wrapper.get('[data-organizing-line]').text()).toBe('选一个 AI 客户端，Astro 用它的模型读项目、补上缺的知识。')
    // Nothing to show yet, so no details button takes room beside the action.
    expect(wrapper.find('[data-organizing-details]').exists()).toBe(false)
    expect(wrapper.get('[data-organizing-start]').text()).toBe('整理')

    const view = await openPanel(wrapper)
    expect(view.textContent).toContain('整理这个项目')
    // Cursor is installed but has no FULI, so it is not offered.
    const names = [...view.querySelectorAll('.new-session-panel__name')].map(item => item.textContent)
    expect(names).toEqual(['Codex', 'OpenCode'])
    const codex = view.querySelector<HTMLAnchorElement>('[data-new-session-open="codex"]')!
    expect(codex.href).toBe(`codex://new?prompt=${encodeURIComponent('#FLA Astro 整理项目 synthetic-project')}`)
    codex.addEventListener('click', event => event.preventDefault())
    codex.click()
    await flushPromises()
    expect(panel()).toBeNull()
    expect(wrapper.get('[data-organizing-line]').text()).toBe('已在 Codex 打开，发送后开始整理')
  })

  it('puts the typed material into the sentence a row opens or copies', async () => {
    vi.mocked(readProjectOrganizing).mockResolvedValue(state())
    const wrapper = await mountCard()
    const view = await openPanel(wrapper)
    const input = view.querySelector<HTMLInputElement>('[data-organizing-material]')!
    input.value = 'docs/, https://example.test/spec'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    const sentence = '#FLA Astro 整理项目 synthetic-project，资料在 docs/, https://example.test/spec'
    expect(decodeURIComponent(view.querySelector<HTMLAnchorElement>('[data-new-session-open="codex"]')!.href.split('prompt=')[1]!)).toBe(sentence)
    view.querySelector<HTMLButtonElement>('[data-new-session-paste="opencode"]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(sentence)
    expect(wrapper.get('[data-organizing-line]').text()).toBe('已复制，在 OpenCode 里粘贴发送')
  })

  it('with no connected client, the only action copies the sentence', async () => {
    clients = []
    vi.mocked(readProjectOrganizing).mockResolvedValue(state())
    const wrapper = await mountCard()
    const view = await openPanel(wrapper)
    expect(view.querySelectorAll('a, [data-new-session-paste], [data-new-session-terminal]')).toHaveLength(0)
    expect(view.querySelectorAll('[data-new-session-copy]')).toHaveLength(1)
    view.querySelector<HTMLButtonElement>('[data-new-session-copy]')!.click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('#FLA Astro 整理项目 synthetic-project')
    expect(wrapper.get('[data-organizing-line]').text()).toBe('已复制，粘贴给你的 AI 发送就开始整理')
  })

  it('shows how much is known and what the last run did; the areas open in 查看详情', async () => {
    vi.mocked(readProjectOrganizing).mockResolvedValue(state({ started: true,
      areas: [{ ...AREAS[0]!, status: 'known' }, { ...AREAS[1]!, status: 'unsure' }, AREAS[2]!],
      progress: { settled: 7, total: 9, complete: false },
      runs: [{ at: '2026-11-11T09:00:00.000Z', model: 'synthetic-opus', tier: 'strong', added: 12, merged: 2, stale: 1, unsure: 3 }] }))
    const wrapper = await mountCard()
    expect(wrapper.get('[data-organizing-progress]').text()).toBe('已了解 7 / 9')
    expect(wrapper.get('[data-organizing-line]').text()).toContain('新增 12、合并 2、过时 1、待你看 3')
    await wrapper.get('[data-organizing-details]').trigger('click')
    const dialog = wrapper.get('[data-organizing-dialog]')
    expect(dialog.get('[data-organizing-area="purpose"]').text()).toContain('已了解')
    expect(dialog.get('[data-organizing-area="stack"]').text()).toContain('待确认')
    expect(dialog.get('[data-organizing-area="run"]').text()).toContain('还缺')
    expect(dialog.get('[data-organizing-runs]').text()).toContain('synthetic-opus · 强')
  })

  it('says when the state cannot be read, and still offers to start', async () => {
    vi.mocked(readProjectOrganizing).mockRejectedValue(new Error('synthetic failure'))
    const wrapper = await mountCard()
    expect(wrapper.get('[data-organizing-progress]').text()).toBe('暂时读不到')
    expect(wrapper.find('[data-organizing-start]').exists()).toBe(true)
  })
})
