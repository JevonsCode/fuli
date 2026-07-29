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
  it('keeps content controls hidden until a quadrant is selected', async () => {
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

    expect(wrapper.find('.quadrant-stage').exists()).toBe(true)
    expect(wrapper.find('.organizer-toolbar').exists()).toBe(false)
    expect(wrapper.find('.organizer-layout').exists()).toBe(false)

    await wrapper.get('[data-quadrant="known_known"]').trigger('click')

    expect(wrapper.find('.quadrant-stage').classes()).toContain('is-focused')
    expect(wrapper.find('.organizer-toolbar').exists()).toBe(true)
    expect(wrapper.findAll('.review-state-filter button')).toHaveLength(3)
    expect(wrapper.find('.organizer-layout').exists()).toBe(true)

    await wrapper.get('.quadrant-reset').trigger('click')

    expect(wrapper.find('.organizer-toolbar').exists()).toBe(false)
    expect(wrapper.find('.organizer-layout').exists()).toBe(false)
    wrapper.unmount()
  })
})
