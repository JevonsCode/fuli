import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import KnowledgeOrganizerPage from './KnowledgeOrganizerPage.vue'

beforeEach(() => {
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
    expect(wrapper.find('.organizer-toolbar').exists()).toBe(true)
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)
    expect(wrapper.findAll('.quadrant-filter button')).toHaveLength(5)
    expect(wrapper.findAll('.review-state-filter button')).toHaveLength(4)

    await wrapper.get('[data-quadrant="known_known"]').trigger('click')

    expect(wrapper.get('[data-quadrant="known_known"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)

    await wrapper.get('[data-quadrant="all"]').trigger('click')

    expect(wrapper.get('[data-quadrant="all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)
    wrapper.unmount()
  })
})
