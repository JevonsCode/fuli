import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const controller = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fit: vi.fn(),
  reset: vi.fn(),
  clearSelection: vi.fn(),
  focusByNames: vi.fn(),
  selectItem: vi.fn(),
  destroy: vi.fn(),
}))
const renderKnowledgeGraph = vi.hoisted(() => vi.fn(() => controller))

vi.mock('./graph-runtime', () => ({
  renderKnowledgeGraph,
}))

import { setLocale } from '@/i18n'
import GraphCanvas from './GraphCanvas.vue'

beforeEach(() => {
  setLocale('zh-CN', { persist: false })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GraphCanvas', () => {
  it('restores the URL-selected graph item after rendering', async () => {
    const wrapper = mount(GraphCanvas, {
      props: {
        graph: {
          nodes: [{ id: 'purpose-1', name: '项目目标', type: 'ProjectPurpose' }],
          edges: [],
        },
        selectedItem: {
          itemKind: 'entity',
          id: 'purpose-1',
        },
      },
    })

    await vi.waitFor(() => {
      expect(controller.selectItem).toHaveBeenCalledWith('entity', 'purpose-1')
    })
    wrapper.unmount()
  })

  it('rerenders the command-driven graph when the interface locale changes', async () => {
    const wrapper = mount(GraphCanvas, {
      props: {
        graph: {
          nodes: [{ id: 'project-1', name: '项目', type: 'PersonalProject' }],
          edges: [],
        },
      },
    })
    await vi.waitFor(() => {
      expect(renderKnowledgeGraph).toHaveBeenCalledTimes(1)
    })

    setLocale('en-US', { persist: false })

    await vi.waitFor(() => {
      expect(renderKnowledgeGraph).toHaveBeenCalledTimes(2)
    })
    wrapper.unmount()
  })
})
