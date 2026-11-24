import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { postJson } from '@/api/client'
import { filterSettings } from '@/features/settings/settings-search'
import { setLocale } from '@/i18n'
import { adoptShownAreas, shown } from './advanced-areas'
import HiddenAreasCard from './HiddenAreasCard.vue'

const EVERY_AREA = ['roundtable', 'tonborg', 'tidy', 'lan'] as const

vi.mock('@/api/client', () => ({ getJson: vi.fn(), putJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn(async () => ({ shown: [] })), deleteJson: vi.fn() }))

beforeEach(() => { setLocale('zh-CN'); vi.mocked(postJson).mockClear() })

describe('HiddenAreasCard', () => {
  it('lists only the areas not shown yet, each with its name and line, and the settings search finds it by name', async () => {
    adoptShownAreas(['tonborg'])
    const wrapper = mount(HiddenAreasCard, { attachTo: document.body })
    expect(wrapper.findAll('[data-hidden-area]').map(row => row.attributes('data-hidden-area'))).toEqual(['roundtable', 'tidy', 'lan'])
    expect(wrapper.text()).toContain('还没用到的功能')
    expect(wrapper.get('[data-hidden-area="lan"]').text()).toContain('局域网配对')
    const root = wrapper.element.parentElement!
    expect(filterSettings(root, '配对')).toBe(1)
    expect(wrapper.get('[data-hidden-area="lan"]').attributes('data-search-hidden')).toBeUndefined()
    expect(wrapper.get('[data-hidden-area="tidy"]').attributes('data-search-hidden')).toBe('')
    expect(filterSettings(root, '圆桌')).toBe(1)
    filterSettings(root, '')
    wrapper.unmount()
  })

  it('names Tonborg by its current name, so a search for Tonborg finds the row', () => {
    adoptShownAreas([])
    const wrapper = mount(HiddenAreasCard, { attachTo: document.body })
    expect(wrapper.get('[data-hidden-area="tonborg"]').text()).toContain('让 Tonborg 替你确认常规的事')
    wrapper.unmount()
  })

  it('shows an area at once on 显示, with no confirmation', async () => {
    adoptShownAreas([])
    const wrapper = mount(HiddenAreasCard, { attachTo: document.body })
    await wrapper.get('[data-show-area="lan"]').trigger('click')
    await flushPromises()
    expect(shown('lan')).toBe(true)
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull()
    expect(postJson).toHaveBeenCalledWith('/api/advanced-areas/reveal', { id: 'lan', why: 'person' }, expect.anything())
    expect(wrapper.find('[data-hidden-area="lan"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders nothing once every area is shown', () => {
    adoptShownAreas([...EVERY_AREA])
    const wrapper = mount(HiddenAreasCard)
    expect(wrapper.find('[data-hidden-areas]').exists()).toBe(false)
    wrapper.unmount()
  })
})
