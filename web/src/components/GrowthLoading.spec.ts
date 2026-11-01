import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'

import motionCss from '../../assets/brand/fuli-motion.css?raw'
import { FULI_MARK } from '@/lib/brand'
import GrowthLoading from './GrowthLoading.vue'

const layers = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('.fuli-mark-group path').map(path => path.attributes('d'))
const cutLayers = (cut: 'master' | 'micro') => {
  const { orbitGold, orbitUpper, wave, bars } = FULI_MARK[cut]
  return [orbitGold, orbitUpper, wave, ...bars]
}

// The declarations of the rules whose selector list matches [selector] exactly.
function declarations(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`${escaped}\\s*{([^}]*)}`, 'g'))].map(match => match[1])
}

describe('GrowthLoading', () => {
  it('keeps one accessible status around the label and hides the decorative mark', () => {
    const wrapper = mount(GrowthLoading, {
      props: { label: '正在读取知识…' },
    })

    expect(wrapper.findAll('[role="status"]')).toHaveLength(1)
    expect(wrapper.attributes('role')).toBe('status')
    expect(wrapper.attributes('aria-live')).toBe('polite')
    expect(wrapper.attributes('aria-label')).toBe('正在读取知识…')
    expect(wrapper.get('.growth-loading__label').text()).toBe('正在读取知识…')
    expect(wrapper.get('.growth-loading__mark').attributes('aria-hidden')).toBe('true')
  })

  it('draws the FULI mark with its gold and ink', () => {
    const wrapper = mount(GrowthLoading, { props: { label: '正在读取知识…' } })
    const mark = wrapper.get('.growth-loading__mark')
    expect(mark.classes()).toEqual(expect.arrayContaining(['fuli-brand-svg', 'is-motion-loading']))
    expect(layers(wrapper)).toEqual(cutLayers('master'))
    expect(wrapper.findAll('.fuli-bar')).toHaveLength(3)
    const gradientId = wrapper.get('linearGradient').attributes('id')
    expect(wrapper.get('.fuli-orbit-gold').attributes('fill')).toBe(`url(#${gradientId})`)
    expect(wrapper.findAll('stop').map(stop => stop.attributes('stop-color'))).toEqual(FULI_MARK.gold.light.map(([, color]) => color))
    expect(new Set(wrapper.findAll('.fuli-mark-group path:not(.fuli-orbit-gold)').map(path => path.attributes('fill')))).toEqual(new Set([FULI_MARK.ink]))
  })

  it('gives every loading its own gradient', () => {
    const two = defineComponent({ render: () => [h(GrowthLoading, { label: '正在读取' }), h(GrowthLoading, { label: '正在保存', variant: 'inline' })] })
    const ids = mount(two).findAll('linearGradient').map(gradient => gradient.attributes('id'))
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it.each([
    ['page', 48, 'master'],
    ['compact', 28, 'master'],
    ['inline', 16, 'micro'],
  ] as const)('uses the same animation and live status in the %s variant at %i px with the %s mark', async (variant, pixels, cut) => {
    const wrapper = mount(GrowthLoading, {
      props: { label: '正在读取 Agent 名录…', variant },
    })
    expect(wrapper.classes()).toContain(`growth-loading--${variant}`)
    expect(wrapper.classes('view-loading')).toBe(variant === 'page')
    expect(wrapper.attributes('style')).toContain(`--growth-loading-size: ${pixels}px`)
    expect(wrapper.get('.growth-loading__mark').attributes('data-cut')).toBe(cut)
    expect(layers(wrapper)).toEqual(cutLayers(cut))
    expect(wrapper.get('.growth-loading__mark').classes()).toContain('is-motion-loading')
    expect(wrapper.attributes('role')).toBe('status')
    await wrapper.setProps({ label: '正在读取任务看板…' })
    expect(wrapper.text()).toBe('正在读取任务看板…')
    expect(wrapper.findAll('div, button, a')).toHaveLength(0)
  })

  it('stands the mark still under the system and the in-app reduced-motion setting', () => {
    const still = /animation: none !important;[\s\S]*transform: none !important;[\s\S]*opacity: 1 !important;/
    const system = motionCss.match(/@media \(prefers-reduced-motion: reduce\) {([\s\S]*?)\n}/)?.[1] ?? ''
    expect(system).toMatch(/\.fuli-brand-svg \*/)
    expect(system).toMatch(still)
    const inApp = declarations(motionCss, ':root[data-motion="reduced"] .fuli-brand-svg *,\n:root[data-motion="reduced"] .fuli-brand-svg .fuli-mark-group')
    expect(inApp).toHaveLength(1)
    expect(inApp[0]).toMatch(still)
  })
})
