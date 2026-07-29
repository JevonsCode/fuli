import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import KnowledgeQuadrantStage from './KnowledgeQuadrantStage.vue'

const choices = [
  { value: 'known_unknown', short: '明确问题', coordinate: '已意识 · 未掌握' },
  { value: 'known_known', short: '明确表达', coordinate: '已意识 · 已掌握' },
  { value: 'unknown_unknown', short: '盲点探索', coordinate: '未意识 · 未掌握' },
  { value: 'unknown_known', short: '隐性提炼', coordinate: '未意识 · 已掌握' },
] as const

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

describe('KnowledgeQuadrantStage', () => {
  it('starts as an axis-based 2×2 discovery map', () => {
    const wrapper = mount(KnowledgeQuadrantStage, {
      props: {
        choices,
        counts: {
          known_known: 12,
          known_unknown: 4,
          unknown_known: 7,
          unknown_unknown: 2,
        },
        activeQuadrant: 'all',
      },
    })

    expect(wrapper.classes()).not.toContain('is-focused')
    expect(wrapper.findAll('.quadrant-axis-system line')).toHaveLength(2)
    expect(wrapper.findAll('.quadrant-axis-arrow')).toHaveLength(2)
    expect(wrapper.find('.quadrant-axis-system marker').exists()).toBe(false)
    expect(wrapper.get('.axis-x-start').text()).toBe('未掌握')
    expect(wrapper.get('.axis-x-end').text()).toBe('已掌握')
    expect(wrapper.get('.axis-y-start').text()).toBe('未意识')
    expect(wrapper.get('.axis-y-end').text()).toBe('已意识')
    expect(wrapper.findAll('.quadrant-card')).toHaveLength(4)
    expect(wrapper.get('[data-quadrant="known_known"]').text()).toContain('12')
    expect(wrapper.findAll('.matrix-card')).toHaveLength(4)
    wrapper.unmount()
  })

  it('turns the focused state into a compact four-way switcher', async () => {
    const wrapper = mount(KnowledgeQuadrantStage, {
      props: {
        choices,
        counts: {},
        activeQuadrant: 'known_known',
      },
    })

    expect(wrapper.classes()).toContain('is-focused')
    expect(wrapper.get('[data-quadrant="known_known"]').classes()).toContain('active-card')
    expect(wrapper.findAll('.quadrant-card')).toHaveLength(4)
    expect(wrapper.findAll('.matrix-card')).toHaveLength(0)
    expect(wrapper.findAll('.active-card')).toHaveLength(1)
    expect(wrapper.get('.quadrant-reset').text()).toBe('全局')
    expect(wrapper.get('.quadrant-reset').attributes('aria-label')).toBe('返回四象限')
    expect(wrapper.find('.compact-axis').exists()).toBe(true)
    expect(wrapper.get('.quadrant-matrix').attributes('style')).toContain(
      '--coordinate-turn: -90deg',
    )
    expect(wrapper.get('.quadrant-matrix').attributes('style')).toContain(
      '--counter-turn: 90deg',
    )

    await wrapper.get('[data-quadrant="unknown_known"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['unknown_known']])

    await wrapper.setProps({ activeQuadrant: 'unknown_known' })
    expect(wrapper.get('[data-quadrant="unknown_known"]').classes()).toContain('active-card')
    expect(wrapper.get('.quadrant-matrix').attributes('style')).toContain(
      '--coordinate-turn: -180deg',
    )
    expect(wrapper.get('.quadrant-matrix').attributes('style')).toContain(
      '--counter-turn: 180deg',
    )

    await wrapper.get('.quadrant-reset').trigger('click')
    expect(wrapper.emitted('select')).toEqual([
      ['unknown_known'],
      ['unknown_known'],
    ])
    wrapper.unmount()
  })

  it('resets accumulated compact turns before entering from the full map again', async () => {
    const wrapper = mount(KnowledgeQuadrantStage, {
      props: {
        choices,
        counts: {},
        activeQuadrant: 'known_known',
      },
    })

    await wrapper.setProps({ activeQuadrant: 'unknown_known' })
    await wrapper.setProps({ activeQuadrant: 'unknown_unknown' })
    await wrapper.setProps({ activeQuadrant: 'known_unknown' })
    expect(wrapper.get('.quadrant-matrix').attributes('style')).toContain(
      '--coordinate-turn: -360deg',
    )

    await wrapper.setProps({ activeQuadrant: 'all' })
    await wrapper.setProps({ activeQuadrant: 'known_known' })

    expect(wrapper.get('.quadrant-matrix').attributes('style')).toContain(
      '--coordinate-turn: -90deg',
    )
    expect(wrapper.get('.quadrant-matrix').attributes('style')).not.toContain(
      '--coordinate-turn: -450deg',
    )
    wrapper.unmount()
  })
})
