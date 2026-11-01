import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { poseTransform } from '@/lib/growing-backdrop'
import { motionPreference } from '@/lib/motion-preference'
import { pageBackdrop } from '@/lib/page-backdrops'
import GrowingBackdrop from './GrowingBackdrop.vue'

describe('GrowingBackdrop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); motionPreference.value = 'system' })

  it('shows the current destination’s motif and changes it with the destination', async () => {
    const wrapper = mount(GrowingBackdrop, { props: { destination: 'chat' } })
    expect(wrapper.get('[data-backdrop]').attributes('data-backdrop')).toBe('chat')
    expect(wrapper.get('[data-backdrop]').attributes('aria-hidden')).toBe('true')

    await wrapper.setProps({ destination: 'settings' })
    expect(wrapper.get('[data-backdrop]').attributes('data-backdrop')).toBe('growth')
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rests at the motif’s first pose with no timer while motion is reduced', async () => {
    motionPreference.value = 'reduced'
    const wrapper = mount(GrowingBackdrop, { props: { destination: 'memory' } })
    const layer = wrapper.get<HTMLElement>('[data-backdrop]').element
    expect(layer.style.transform).toBe(poseTransform(pageBackdrop('memory').drift.from))
    expect(vi.getTimerCount()).toBe(0)

    motionPreference.value = 'system'
    await wrapper.vm.$nextTick()
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
  })
})
