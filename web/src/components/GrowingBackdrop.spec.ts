import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import primitives from '@/styles/primitives.css?raw'
import { pageBackdrop } from '@/lib/page-backdrops'
import GrowingBackdrop from './GrowingBackdrop.vue'
import source from './GrowingBackdrop.vue?raw'

const style = source.slice(source.indexOf('<style'))
const keyframes = [...style.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map(([, body]) => body)

describe('GrowingBackdrop', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('shows the current destination’s motif as its own layers and changes it with the destination', async () => {
    const wrapper = mount(GrowingBackdrop, { props: { destination: 'chat' } })
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-backdrop]').attributes('data-backdrop')).toBe('chat')
    expect(wrapper.findAll('.backdrop-layer')).toHaveLength(pageBackdrop('chat').layers.length)

    await wrapper.setProps({ destination: 'settings' })
    expect(wrapper.get('[data-backdrop="growth"]').findAll('.backdrop-layer')).toHaveLength(pageBackdrop('settings').layers.length)
    wrapper.unmount()
  })

  it('moves its layers by transform and opacity only, never by anything that lays out or paints', () => {
    expect(keyframes.length).toBeGreaterThanOrEqual(2)
    for (const body of keyframes) {
      const properties = new Set([...body.matchAll(/([\w-]+):/g)].map(([, property]) => property))
      expect([...properties].every(property => property === 'transform' || property === 'opacity')).toBe(true)
    }
    expect(style).toMatch(/\.backdrop-layer \{[\s\S]*animation:[\s\S]*infinite/)
    expect(style).toMatch(/\.backdrop-layer \{[\s\S]*will-change: transform, opacity/)
    expect(style).not.toMatch(/\b\d+m?s\b/)
  })

  it('rests while motion is reduced: the shared rule zeroes every animation, the system’s and the app’s', () => {
    // No fill mode, so a zero-length animation leaves each layer at its resting pose.
    expect(style).not.toMatch(/forwards|both|animation-fill-mode/)
    expect(primitives).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0s !important/)
    expect(primitives).toMatch(/:root\[data-motion="reduced"\] \*[\s\S]*animation-duration: 0s !important/)
  })

  it('leans with the mouse and lets go of the pointer when it leaves', () => {
    const wrapper = mount(GrowingBackdrop, { props: { destination: 'projects' } })
    const stage = wrapper.element as HTMLElement
    const move = () => {
      const event = new MouseEvent('pointermove', { clientX: 0, clientY: 0 }) as PointerEvent
      Object.defineProperty(event, 'pointerType', { value: 'mouse' })
      window.dispatchEvent(event)
    }
    move()
    vi.advanceTimersByTime(200)
    expect(Number(stage.style.getPropertyValue('--parallax-x'))).toBeGreaterThan(0)

    move()
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    const removed = stage.style.getPropertyValue('--parallax-x')
    move()
    vi.advanceTimersByTime(200)
    expect(stage.style.getPropertyValue('--parallax-x')).toBe(removed)
  })
})
