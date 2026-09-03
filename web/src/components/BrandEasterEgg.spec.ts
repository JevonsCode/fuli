import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import BrandEasterEgg from './BrandEasterEgg.vue'

const { getJsonMock } = vi.hoisted(() => ({ getJsonMock: vi.fn() }))

vi.mock('@/api/client', () => ({ getJson: getJsonMock }))

describe('BrandEasterEgg', () => {
  beforeEach(() => {
    getJsonMock.mockReset()
    getJsonMock.mockResolvedValue({
      status: 'ready',
      currentVersion: '0.7.8',
      latestVersion: '0.7.8',
      updateAvailable: false,
      packageUrl: 'https://www.npmjs.com/package/fuli-context',
      checkedAt: '2026-09-03T08:00:00.000Z',
    })
  })

  it('plays, finishes, and can replay the brand light effect', async () => {
    const wrapper = mount(BrandEasterEgg)
    const button = wrapper.get('.brand-effect-button')

    expect(button.attributes('aria-label')).toBe('复利，触发品牌光效')
    expect(wrapper.get('.brand-block').classes()).not.toContain('is-sparkling')

    window.dispatchEvent(new Event('pointerdown'))
    await button.trigger('focus')
    expect(wrapper.get('.brand-block').classes()).not.toContain('is-keyboard-focused')

    await button.trigger('blur')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    await button.trigger('focus')
    expect(wrapper.get('.brand-block').classes()).toContain('is-keyboard-focused')
    await button.trigger('blur')

    await button.trigger('click')
    const firstReflection = wrapper.get('.brand-copy-reflection').element
    expect(wrapper.get('.brand-block').classes()).toContain('is-sparkling')
    expect(wrapper.find('.brand-orbit').exists()).toBe(true)
    expect(wrapper.find('.brand-mark-reflection').exists()).toBe(false)
    expect(wrapper.findAll('.brand-copy-reflection')).toHaveLength(1)
    expect(wrapper.get('.brand-copy-reflection').text()).not.toContain('Context Graph')
    expect(wrapper.get('.brand-copy > .brand-subtitle').text()).toBe('Context Graph')

    await wrapper.get('.brand-copy-reflection').trigger('animationend')
    expect(wrapper.get('.brand-block').classes()).not.toContain('is-sparkling')
    expect(wrapper.find('.brand-orbit').exists()).toBe(false)

    await button.trigger('click')
    expect(wrapper.get('.brand-copy-reflection').element).not.toBe(firstReflection)
    expect(wrapper.get('.brand-block').classes()).toContain('is-sparkling')
    wrapper.unmount()
  })

  it('marks a newer version and reveals safe update instructions', async () => {
    getJsonMock.mockResolvedValue({
      status: 'ready',
      currentVersion: '0.7.8',
      latestVersion: '0.8.0',
      updateAvailable: true,
      packageUrl: 'https://www.npmjs.com/package/fuli-context',
      checkedAt: '2026-09-03T08:00:00.000Z',
    })
    const wrapper = mount(BrandEasterEgg, { attachTo: document.body })
    await flushPromises()

    expect(getJsonMock).toHaveBeenCalledWith('/api/system/version', {
      signal: expect.any(AbortSignal),
    })
    expect(wrapper.find('.brand-update-dot').exists()).toBe(true)
    const versionButton = wrapper.get('.brand-version-button')
    expect(versionButton.attributes('aria-label')).toContain('0.8.0')

    await versionButton.trigger('click')
    expect(versionButton.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.brand-update-popover').text()).toContain('fuli update --yes')
    expect(wrapper.get('.brand-update-popover a').attributes('href'))
      .toBe('https://www.npmjs.com/package/fuli-context')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.brand-update-popover').exists()).toBe(false)
    expect(document.activeElement).toBe(versionButton.element)
    wrapper.unmount()
  })

  it('stays quiet when the version service is unavailable', async () => {
    getJsonMock.mockRejectedValue(new Error('offline'))
    const wrapper = mount(BrandEasterEgg)
    await flushPromises()

    expect(wrapper.find('.brand-update-dot').exists()).toBe(false)
    expect(wrapper.find('.brand-version-button').exists()).toBe(false)
    expect(wrapper.get('.brand-version').text()).toMatch(/^v/)
    wrapper.unmount()
  })
})
