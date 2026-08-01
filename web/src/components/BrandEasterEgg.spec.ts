import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import BrandEasterEgg from './BrandEasterEgg.vue'

describe('BrandEasterEgg', () => {
  it('plays, finishes, and can replay the brand light effect', async () => {
    const wrapper = mount(BrandEasterEgg)
    const button = wrapper.get('button')

    expect(button.attributes('aria-label')).toBe('复利，触发品牌光效')
    expect(button.classes()).not.toContain('is-sparkling')

    window.dispatchEvent(new Event('pointerdown'))
    await button.trigger('focus')
    expect(button.classes()).not.toContain('is-keyboard-focused')

    await button.trigger('blur')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    await button.trigger('focus')
    expect(button.classes()).toContain('is-keyboard-focused')
    await button.trigger('blur')

    await button.trigger('click')
    const firstReflection = wrapper.get('.brand-copy-reflection').element
    expect(button.classes()).toContain('is-sparkling')
    expect(wrapper.find('.brand-orbit').exists()).toBe(true)
    expect(wrapper.find('.brand-mark-reflection').exists()).toBe(false)
    expect(wrapper.findAll('.brand-copy-reflection')).toHaveLength(1)
    expect(wrapper.get('.brand-copy-reflection').text()).not.toContain('Context Graph')
    expect(wrapper.get('.brand-copy > .brand-subtitle').text()).toBe('Context Graph')

    await wrapper.get('.brand-copy-reflection').trigger('animationend')
    expect(button.classes()).not.toContain('is-sparkling')
    expect(wrapper.find('.brand-orbit').exists()).toBe(false)

    await button.trigger('click')
    expect(wrapper.get('.brand-copy-reflection').element).not.toBe(firstReflection)
    expect(button.classes()).toContain('is-sparkling')
  })
})
