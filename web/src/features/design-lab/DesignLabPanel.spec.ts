import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { setPalettePreference } from '@/lib/palette-preference'
import DesignLabPanel from './DesignLabPanel.vue'
import { designLab, resetDesignLab } from './design-lab'

afterEach(() => {
  resetDesignLab()
  designLab.value.open = false
  setPalettePreference('jade')
  window.localStorage.clear()
})

describe('DesignLabPanel', () => {
  it('opens from the launcher and recolours the console from a palette choice', async () => {
    const wrapper = mount(DesignLabPanel)
    await wrapper.get('[data-design-lab-open]').trigger('click')
    expect(wrapper.find('[data-design-lab]').exists()).toBe(true)

    const gold = wrapper.findAll('[data-lab-palette] button').find(button => button.text().includes('复利金'))!
    await gold.trigger('click')
    expect(document.documentElement.dataset.palette).toBe('gold')
    expect(gold.attributes('aria-pressed')).toBe('true')
    wrapper.unmount()
  })

  it('applies motion choices as document attributes and resets them', async () => {
    designLab.value.open = true
    const wrapper = mount(DesignLabPanel)
    await wrapper.findAll('[data-lab-transition] button').find(button => button.text() === '上浮')!.trigger('click')
    await wrapper.get('[data-lab-lift]').trigger('click')
    await nextTick()
    expect(document.documentElement.dataset.labTransition).toBe('rise')
    expect(document.documentElement.dataset.labLift).toBe('on')
    expect(JSON.parse(window.localStorage.getItem('fuli.lab')!)).toMatchObject({ transition: 'rise', cardLift: true })

    await wrapper.get('[data-design-lab-reset]').trigger('click')
    await nextTick()
    expect(document.documentElement.dataset.labTransition).toBeUndefined()
    expect(document.documentElement.dataset.labLift).toBeUndefined()
    await wrapper.get('[data-design-lab-close]').trigger('click')
    expect(wrapper.find('[data-design-lab]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('DesignLabPanel A/B choices', () => {
  it('applies card, density, radius and ring choices to the document and resets them', async () => {
    designLab.value.open = true
    const wrapper = mount(DesignLabPanel)
    const pick = (key: string, label: string) => wrapper.findAll(`[data-lab-choice="${key}"] button`).find(button => button.text() === label)!.trigger('click')
    await pick('cards', '阴影')
    await pick('density', '紧凑')
    await pick('radius', '大')
    await pick('ring', '静止')
    await nextTick()
    const root = document.documentElement.dataset
    expect([root.theme, root.labCards, root.labDensity, root.labRadius, root.labRing]).toEqual([undefined, 'shadow', 'compact', 'large', 'still'])

    await wrapper.get('[data-design-lab-reset]').trigger('click')
    await nextTick()
    expect([root.theme, root.labCards, root.labDensity, root.labRadius, root.labRing]).toEqual([undefined, undefined, undefined, undefined, undefined])
    wrapper.unmount()
  })

  it('drags the launcher without opening the lab, opens on a plain click, and returns home on resize', async () => {
    const wrapper = mount(DesignLabPanel, { attachTo: document.body })
    const launcher = () => wrapper.get('[data-design-lab-open]')
    const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, bubbles: true })
    launcher().element.dispatchEvent(pointer('pointerdown', 100, 100))
    window.dispatchEvent(pointer('pointermove', 60, 50))
    window.dispatchEvent(pointer('pointerup', 60, 50))
    await launcher().trigger('click')
    await nextTick()
    expect(designLab.value.open).toBe(false)
    expect(launcher().attributes('style')).toContain('right: auto')
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(launcher().attributes('style') ?? '').not.toContain('right: auto')
    launcher().element.dispatchEvent(pointer('pointerdown', 10, 10))
    window.dispatchEvent(pointer('pointerup', 11, 11))
    await launcher().trigger('click')
    expect(designLab.value.open).toBe(true)
    wrapper.unmount()
  })
})
