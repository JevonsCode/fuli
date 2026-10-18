import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ICONS } from './icons'
import { UiAvatar, UiChipRow, UiEmpty, UiIcon, UiIconButton, UiSegmented, UiToggle, UiWeight, weightBand } from './index'

afterEach(() => vi.restoreAllMocks())

describe('design system', () => {
  it('draws every icon decoratively unless it is labelled', () => {
    for (const name of Object.keys(ICONS) as (keyof typeof ICONS)[]) {
      const svg = mount(UiIcon, { props: { name } }).get('svg')
      expect(svg.attributes('aria-hidden')).toBe('true')
      expect(svg.html()).toContain('<')
    }
    expect(mount(UiIcon, { props: { name: 'search', label: 'Search' } }).get('svg').attributes('aria-label')).toBe('Search')
  })

  it('gives icon-only buttons an accessible name and tooltip instead of visible words', () => {
    const button = mount(UiIconButton, { props: { icon: 'sort', label: '排序', active: true } }).get('button')
    expect(button.text()).toBe('')
    expect(button.attributes('aria-label')).toBe('排序')
    expect(button.attributes('title')).toBe('排序')
    expect(button.attributes('aria-pressed')).toBe('true')
  })

  it('shows Agent status as a ring that is phase-locked for looping states', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2400 * 3 + 500)
    const working = mount(UiAvatar, { props: { name: 'jefa', status: 'working', color: '#123456' } })
    expect(working.classes()).toContain('is-working')
    expect(working.text()).toBe('J')
    expect(working.attributes('style')).toContain('--avatar-phase: -500ms')
    expect(working.attributes('style')).toContain('--avatar-color: #123456')
    const idle = mount(UiAvatar, { props: { name: 'bole', status: 'idle' } })
    expect(idle.attributes('style') ?? '').not.toContain('--avatar-phase')
    expect(idle.attributes('data-status')).toBe('idle')
  })

  it('switches with real switch semantics', async () => {
    const toggle = mount(UiToggle, { props: { modelValue: false, label: 'Capture' } })
    const button = toggle.get('[role="switch"]')
    expect(button.attributes('aria-checked')).toBe('false')
    await button.trigger('click')
    expect(toggle.emitted('update:modelValue')?.[0]).toEqual([true])
  })

  it('maps weights to the user-decided bands and marks a person confirmation', () => {
    expect([weightBand(10), weightBand(69), weightBand(70), weightBand(95), weightBand(100), weightBand(40, true)])
      .toEqual(['pending', 'pending', 'agent', 'agent', 'person', 'person'])
    const meter = mount(UiWeight, { props: { percent: 82.4, label: '权重' } }).get('[role="meter"]')
    expect(meter.attributes('aria-valuenow')).toBe('82')
    expect(meter.attributes('data-weight-band')).toBe('agent')
    expect(mount(UiWeight, { props: { percent: 100, label: '权重' } }).find('svg').exists()).toBe(true)
  })

  it('keeps chips one height in a shared row and shows empty states in place', () => {
    const row = mount(UiChipRow, { slots: { default: '<span class="ui-chip">a</span><span class="ui-chip">b</span>' } })
    expect(row.classes()).toContain('ui-chip-row')
    expect(mount(UiEmpty, { props: { text: '还没有对话' } }).get('[role="status"]').text()).toContain('还没有对话')
  })

  it('shows icon-only segmented options with an accessible name', () => {
    const segmented = mount(UiSegmented, { props: { modelValue: 'grid', label: '视图',
      options: [{ value: 'grid', label: '卡片', icon: 'grid', iconOnly: true }, { value: 'list', label: '列表', icon: 'list', iconOnly: true }] } })
    const [grid] = segmented.findAll('button')
    expect(grid.text()).toBe('')
    expect(grid.attributes('aria-label')).toBe('卡片')
    expect(grid.attributes('aria-pressed')).toBe('true')
  })
})