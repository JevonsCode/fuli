import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref, type Ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isLoadingPreviewEnabled,
  LOADING_VISIBILITY_DELAY_MS,
  MINIMUM_LOADING_DISPLAY_MS,
  useMinimumLoadingDisplay,
} from './useMinimumLoadingDisplay'

afterEach(() => {
  vi.useRealTimers()
})

describe('useMinimumLoadingDisplay', () => {
  it('waits for the visibility delay before showing a loading state', async () => {
    expect(LOADING_VISIBILITY_DELAY_MS).toBe(120)
    expect(MINIMUM_LOADING_DISPLAY_MS).toBe(180)
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS - 1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)

    active.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS - 1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('never flashes for a request that ends before the visibility delay', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    active.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS + MINIMUM_LOADING_DISPLAY_MS)
    await nextTick()

    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('uses the caller minimum when it is longer than the shared default', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active, 420))

    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)

    active.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(419)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('restarts the delay when a pending request is replaced', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    await vi.advanceTimersByTimeAsync(60)
    active.value = false
    await nextTick()
    active.value = true
    await nextTick()

    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS - 1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('cancels a pending hide when a request starts again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS)
    await nextTick()
    active.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(60)
    active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS + 1)
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(true)

    active.value = false
    await nextTick()
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('clears a pending show when the host unmounts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS)
    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
  })

  it('clears visibility timers when the host unmounts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    await vi.advanceTimersByTimeAsync(LOADING_VISIBILITY_DELAY_MS)
    await nextTick()
    active.value = false
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS + LOADING_VISIBILITY_DELAY_MS)
  })
})

describe('isLoadingPreviewEnabled', () => {
  it('enables only the explicit testLoading=1 preview query', () => {
    expect(isLoadingPreviewEnabled('?testLoading=1')).toBe(true)
    expect(isLoadingPreviewEnabled('?testLoading=0')).toBe(false)
    expect(isLoadingPreviewEnabled('?testLoading=true')).toBe(false)
    expect(isLoadingPreviewEnabled('?other=1')).toBe(false)
  })
})

function loadingHost(active: Ref<boolean>, minimumMs = MINIMUM_LOADING_DISPLAY_MS) {
  return defineComponent({
    setup() {
      return { visible: useMinimumLoadingDisplay(active, minimumMs) }
    },
    template: '<span v-if="visible" data-testid="loading" />',
  })
}
