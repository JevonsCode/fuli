import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./graph-runtime', () => ({
  renderKnowledgeGraph: vi.fn(() => controller),
}))

import GraphCanvas from './GraphCanvas.vue'

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
})
