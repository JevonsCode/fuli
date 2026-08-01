import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref, type Ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isLoadingPreviewEnabled,
  MINIMUM_LOADING_DISPLAY_MS,
  useMinimumLoadingDisplay,
} from './useMinimumLoadingDisplay'

afterEach(() => {
  vi.useRealTimers()
})

describe('useMinimumLoadingDisplay', () => {
  it('keeps a short loading state visible for at least 500ms', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

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

  it('hides immediately when the real loading state already lasted 500ms', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const active = ref(true)
    const wrapper = mount(loadingHost(active))

    await vi.advanceTimersByTimeAsync(MINIMUM_LOADING_DISPLAY_MS)
    active.value = false
    await nextTick()

    expect(wrapper.find('[data-testid="loading"]').exists()).toBe(false)
    wrapper.unmount()
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

function loadingHost(active: Ref<boolean>) {
  return defineComponent({
    setup() {
      return { visible: useMinimumLoadingDisplay(active) }
    },
    template: '<span v-if="visible" data-testid="loading" />',
  })
}
