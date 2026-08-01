import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    expect(wrapper.findAll('.quadrant-filter button')).toHaveLength(5)
    expect(wrapper.findAll('.review-state-filter button')).toHaveLength(4)

    const toolbarActions = wrapper.get('.organizer-toolbar-actions')
    expect(toolbarActions.find('.organizer-result-summary').exists()).toBe(true)
    expect(toolbarActions.findAll('.toolbar-action')).toHaveLength(1)

    await wrapper.get('[data-quadrant="known_known"]').trigger('click')

    expect(wrapper.get('[data-quadrant="known_known"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)

    await wrapper.get('[data-quadrant="all"]').trigger('click')

    expect(wrapper.get('[data-quadrant="all"]').attributes('aria-pressed')).toBe('true')
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
    expect(wrapper.get('.virtual-directory-list__watermark').text()).toBe('#001')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 101')

    const directory = wrapper.get('.virtual-directory-list__scroller')
    directory.element.scrollTop = 68 * 50
    await directory.trigger('scroll')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('051/ 101')

    await wrapper.get('.organizer-search input').setValue('最后一页')
    await flushPromises()
    expect(wrapper.findAll('.organizer-row')).toHaveLength(1)
    expect(wrapper.get('.organizer-row').text()).toContain('最后一页的知识')
    expect(wrapper.get('.virtual-directory-list__watermark').text()).toBe('#001')
    expect(wrapper.get('.virtual-directory-list__position').text()).toBe('001/ 001')
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
