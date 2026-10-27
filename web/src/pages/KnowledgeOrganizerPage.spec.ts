import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { MINIMUM_LOADING_DISPLAY_MS } from '@/composables/useMinimumLoadingDisplay'

const getJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  getJson,
  patchJson: vi.fn(),
  postJson: vi.fn(),
}))

import { useConsoleStore } from '@/stores/console'
import KnowledgeOrganizerPage from './KnowledgeOrganizerPage.vue'

beforeEach(() => {
  window.history.replaceState({}, '', '/')
  getJson.mockReset()
  getJson.mockResolvedValue({ nodes: [], edges: [], truncated: false, next_offset: null })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  vi.useRealTimers()
  window.history.replaceState({}, '', '/')
})

describe('KnowledgeOrganizerPage', () => {
  it('keeps knowledge visible while quadrants act only as discovery-source filters', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)

    const wrapper = mount(KnowledgeOrganizerPage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeBatchConfirmDialog: true,
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
        },
      },
    })

    expect(wrapper.find('.quadrant-stage').exists()).toBe(false)
    expect(wrapper.find('.organizer-head').exists()).toBe(false)
    expect(wrapper.find('.organizer-toolbar').exists()).toBe(true)
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)
    expect(wrapper.get('.organizer-toolbar').element.closest('template')).toBeNull()
    expect(wrapper.get('.organizer-layout').element.closest('template')).toBeNull()
    expect(wrapper.findAll('[data-organizer-quadrants] button')).toHaveLength(5)
    expect(wrapper.findAll('[data-stat]')).toHaveLength(5)

    const toolbarActions = wrapper.get('.organizer-toolbar .ui-toolbar-end')
    expect(toolbarActions.find('.organizer-result-summary').exists()).toBe(true)
    expect(toolbarActions.findAll('.batch-confirm-action')).toHaveLength(0)
    expect(toolbarActions.findAll('[data-size^="icon"]')).toHaveLength(1)

    await wrapper.get('[data-organizer-quadrants] [data-value="known_known"]').trigger('click')

    expect(wrapper.get('[data-organizer-quadrants] [data-value="known_known"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)

    await wrapper.get('[data-organizer-quadrants] [data-value="all"]').trigger('click')

    expect(wrapper.get('[data-organizer-quadrants] [data-value="all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)
    wrapper.unmount()
  })

  it('loads every graph page automatically while virtualizing the rendered rows', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const firstPage = Array.from({ length: 100 }, (_, index) => knowledgeNode(index))
    getJson.mockImplementation((rawUrl: string) => {
      const url = new URL(rawUrl, 'http://localhost')
      if (url.searchParams.get('offset') === '0') {
        return Promise.resolve({
          space_id: 'personal-space',
          nodes: firstPage,
          edges: [],
          truncated: true,
          next_offset: 100,
        })
      }
      return Promise.resolve({
        space_id: 'personal-space',
        nodes: [knowledgeNode(100, '最后一页的知识')],
        edges: [],
        truncated: false,
        next_offset: null,
      })
    })

    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }

    // The page (here a stand-in scroll box) is the list's one scroll container.
    const page = document.body.appendChild(document.createElement('div'))
    page.style.overflowY = 'auto'
    const wrapper = mount(KnowledgeOrganizerPage, {
      attachTo: page,
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeBatchConfirmDialog: true,
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
        },
      },
    })
    await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS)
    vi.useRealTimers()
    await flushPromises()

    expect(getJson.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/graph?spaceId=personal-space&limit=100&offset=0',
      '/api/graph?spaceId=personal-space&limit=100&offset=100',
    ])
    expect(wrapper.find('.organizer-truncated').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('本页统计只覆盖')
    expect(wrapper.get('.virtual-directory-list__canvas').attributes('style')).toContain('height: 6868px')
    expect(wrapper.findAll('.organizer-row').length).toBeLessThan(101)
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 101')

    // The page is the one scroll container: the table follows the page's scroll.
    expect(wrapper.get('.virtual-directory-list').classes()).toContain('is-page-scroll')
    // jsdom has no layout: the rows' canvas moves up by what the page scrolled.
    const canvas = wrapper.get('.virtual-directory-list__canvas').element
    canvas.getBoundingClientRect = () => ({ top: -page.scrollTop }) as DOMRect
    page.scrollTop = 68 * 50
    page.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('051/ 101')

    await wrapper.get('.organizer-search input').setValue('最后一页')
    await flushPromises()
    expect(wrapper.findAll('.organizer-row')).toHaveLength(1)
    expect(wrapper.get('.organizer-row').text()).toContain('最后一页的知识')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 001')
    wrapper.unmount()
    page.remove()
  })

  it('counts and filters effective Tonborg reviews, then returns them to pending after invalidation', async () => {
    const reviewed = {
      ...knowledgeNode(1, 'Tonborg item'),
      ai_review_evidence_token: 'a'.repeat(64),
      ai_assessment: {
        outcome: 'approve',
        summary: 'Current version is useful.',
        evidence: ['Direct item content'],
        confidence: 0.8,
        client: 'codex',
      },
    }
    const pending = knowledgeNode(2, 'Pending item')
    getJson
      .mockResolvedValueOnce({
        space_id: 'personal-space',
        nodes: [reviewed, pending],
        edges: [],
        truncated: false,
        next_offset: null,
      })
      .mockResolvedValueOnce({
        space_id: 'personal-space',
        nodes: [
          { ...reviewed, ai_assessment: null },
          pending,
        ],
        edges: [],
        truncated: false,
        next_offset: null,
      })

    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }

    const wrapper = mount(KnowledgeOrganizerPage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeBatchConfirmDialog: true,
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('[data-stat="ai_reviewed"] strong').text()).toBe('1')
    expect(wrapper.get('[data-stat="pending"] strong').text()).toBe('1')
    await wrapper.get('[data-stat="ai_reviewed"]').trigger('click')
    expect(wrapper.findAll('.organizer-row')).toHaveLength(1)
    expect(wrapper.get('.organizer-row').text()).toContain('Tonborg item')

    await wrapper.get('.organizer-toolbar .ui-toolbar-end [data-size^="icon"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-stat="ai_reviewed"] strong').text()).toBe('0')
    expect(wrapper.get('[data-stat="pending"] strong').text()).toBe('2')
    wrapper.unmount()
  })

  it('opens an item in a quick look over the one list instead of a column beside it', async () => {
    getJson.mockResolvedValue({ space_id: 'personal-space', nodes: [knowledgeNode(1, 'Peek item')], edges: [], truncated: false, next_offset: null })
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().state = {
      mode: 'personal_only', activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
    }
    const wrapper = mount(KnowledgeOrganizerPage, { global: { plugins: [pinia], stubs: { KnowledgeBatchConfirmDialog: true } } })
    await flushPromises()
    const peek = () => new DOMWrapper(document.body).find('[data-knowledge-peek]')

    await wrapper.get('.organizer-row').trigger('click')
    await flushPromises()
    expect(peek().get('h2').text()).toBe('Peek item')
    expect(wrapper.get('.organizer-row').classes()).toContain('selected')
    expect(wrapper.find('.knowledge-inspector').exists()).toBe(false)

    await peek().trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(peek().exists()).toBe(false)
    expect(wrapper.get('.organizer-row').classes()).not.toContain('selected')
    wrapper.unmount()
  })

  it('keeps the loading artwork visible when testLoading=1 is present', async () => {
    window.history.replaceState({}, '', '/organize?testLoading=1')
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }],
      personalProjects: [],
      projects: [],
      subscriptions: [],
    }

    const wrapper = mount(KnowledgeOrganizerPage, {
      global: {
        plugins: [pinia],
        stubs: {
          KnowledgeBatchConfirmDialog: true,
          KnowledgeConfirmDialog: true,
          KnowledgeEditDialog: true,
          KnowledgeInspector: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.get('.growth-loading').text()).toBe('正在读取知识…')
    expect(wrapper.find('.organizer-layout').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('KnowledgeOrganizerPage quick look in the URL (D-03 §2)', () => {
  async function routed(path: string, nodes = [knowledgeNode(1, 'Peek item'), knowledgeNode(2, 'Other item')]) {
    getJson.mockResolvedValue({ space_id: 'personal-space', nodes, edges: [], truncated: false, next_offset: null })
    const pinia = createPinia()
    setActivePinia(pinia)
    useConsoleStore().state = {
      mode: 'personal_only', activePersonalSpaceId: 'personal-space',
      personalSpaces: [{ id: 'personal-space', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
    }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/organize', component: { template: '<div />' } }] })
    await router.push(path)
    await router.isReady()
    const wrapper = mount(KnowledgeOrganizerPage, {
      attachTo: document.body,
      global: { plugins: [pinia, router], stubs: { KnowledgeBatchConfirmDialog: true } },
    })
    await flushPromises()
    return { router, wrapper }
  }
  const peek = () => new DOMWrapper(document.body).find('[data-knowledge-peek]')
  const row = (wrapper: Awaited<ReturnType<typeof routed>>['wrapper'], key: string) =>
    wrapper.get(`.organizer-row[data-return-focus="${key}"]`)

  it('names the item and its space in the URL, and Back closes it with focus on the opener', async () => {
    const { router, wrapper } = await routed('/organize')
    const opener = row(wrapper, 'entity:knowledge-2')
    ;(opener.element as HTMLElement).focus()
    await opener.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.item).toBe('personal-space/entity%3Aknowledge-2')
    expect(peek().get('h2').text()).toBe('Other item')
    expect(opener.classes()).toContain('selected')

    router.back()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/organize')
    expect(peek().exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
    wrapper.unmount()
  })

  it('reopens the same item on direct entry; Esc drops it from the URL and focuses its row', async () => {
    const { router, wrapper } = await routed('/organize?item=personal-space%2Fentity%253Aknowledge-1')
    expect(peek().get('h2').text()).toBe('Peek item')
    expect(row(wrapper, 'entity:knowledge-1').classes()).toContain('selected')

    await peek().trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(peek().exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/organize')
    expect(document.activeElement).toBe(row(wrapper, 'entity:knowledge-1').element)
    wrapper.unmount()
  })

  it('drops an item the read collection does not hold, or one from another space', async () => {
    for (const item of ['personal-space%2Fentity%253Amissing', 'other-space%2Fentity%253Aknowledge-1']) {
      const { router, wrapper } = await routed(`/organize?item=${item}`)
      expect(peek().exists()).toBe(false)
      expect(router.currentRoute.value.query.item).toBeUndefined()
      wrapper.unmount()
    }
  })

  describe('with the linked item on a later page', () => {
    const link = '/organize?item=personal-space%2Fentity%253Aknowledge-2'
    const first = (nextOffset: unknown = 1) => ({ space_id: 'personal-space', nodes: [knowledgeNode(1, 'First page item')], edges: [], truncated: true, next_offset: nextOffset })
    const second = { space_id: 'personal-space', nodes: [knowledgeNode(2, 'Later page item')], edges: [], truncated: false, next_offset: null }
    function pages(later: () => Promise<unknown>, firstPage = first()) {
      getJson.mockImplementation((url: string) =>
        new URLSearchParams(url.split('?')[1]).get('offset') === '0' ? Promise.resolve(firstPage) : later())
    }
    async function routedPaged(path: string) {
      const pinia = createPinia()
      setActivePinia(pinia)
      useConsoleStore().state = {
        mode: 'personal_only', activePersonalSpaceId: 'personal-space',
        personalSpaces: [{ id: 'personal-space', name: '我' }], personalProjects: [], projects: [], subscriptions: [],
      }
      const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/organize', component: { template: '<div />' } }] })
      await router.push(path)
      await router.isReady()
      const wrapper = mount(KnowledgeOrganizerPage, { attachTo: document.body, global: { plugins: [pinia, router], stubs: { KnowledgeBatchConfirmDialog: true } } })
      await flushPromises()
      return { router, wrapper }
    }

    it('opens it once every page has arrived', async () => {
      pages(() => Promise.resolve(second))
      const { router, wrapper } = await routedPaged(link)
      expect(peek().get('h2').text()).toBe('Later page item')
      expect(router.currentRoute.value.query.item).toBe('personal-space/entity%3Aknowledge-2')
      wrapper.unmount()
    })

    it.each([
      ['a later page fails (503)', () => pages(() => Promise.reject(Object.assign(new Error('synthetic 503'), { status: 503 })))],
      ['a page returns an invalid next offset', () => pages(() => Promise.resolve(second), first(0))],
      ['the first page fails', () => getJson.mockRejectedValue(Object.assign(new Error('synthetic 503'), { status: 503 }))],
    ])('keeps the link and offers a retry when %s', async (_case, arrange) => {
      arrange()
      const { router, wrapper } = await routedPaged(link)
      expect(router.currentRoute.value.query.item).toBe('personal-space/entity%3Aknowledge-2')
      expect(peek().exists()).toBe(false)
      const notice = wrapper.get('[data-organizer-link-incomplete]')

      pages(() => Promise.resolve(second))
      await notice.get('button').trigger('click')
      await flushPromises()
      expect(peek().get('h2').text()).toBe('Later page item')
      expect(wrapper.find('[data-organizer-link-incomplete]').exists()).toBe(false)
      expect(router.currentRoute.value.query.item).toBe('personal-space/entity%3Aknowledge-2')
      wrapper.unmount()
    })
  })
})

function knowledgeNode(index: number, name = `知识 ${index}`) {
  return {
    id: `knowledge-${index}`,
    name,
    type: 'Requirement',
    summary: `内容 ${index}`,
    origin_quadrant: 'known_known',
    epistemic_state_explicit: true,
    confirmation_status: 'pending',
    confirmation_state_explicit: false,
    created_at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    evidence: [],
  }
}
