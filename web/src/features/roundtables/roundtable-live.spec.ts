import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type ComputedRef, type Ref } from 'vue'

const listThreads = vi.fn()
vi.mock('./roundtable-api', () => ({ listThreads: () => listThreads() }))

async function load() {
  vi.resetModules()
  return import('./roundtable-live')
}
function host(useLive: (space: Ref<string>, enabled: Ref<boolean>) => ComputedRef<boolean>, enabled = ref(true)) {
  let live!: ComputedRef<boolean>
  const wrapper = mount(defineComponent({ setup() { live = useLive(ref('space'), enabled); return () => h('div') } }))
  return { wrapper, live: () => live.value }
}

beforeEach(() => { listThreads.mockReset(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('roundtable live state', () => {
  it('is live only while some conversation has an Agent replying', async () => {
    const { useRoundtableLive } = await load()
    listThreads.mockResolvedValue({ threads: [{ replying: false }, { replying: true }] })
    const { wrapper, live } = host(useRoundtableLive)
    await flushPromises()
    expect(live()).toBe(true)
    listThreads.mockResolvedValue({ threads: [{ replying: false }, {}] })
    vi.advanceTimersByTime(15_000)
    await flushPromises()
    expect(live()).toBe(false)
    wrapper.unmount()
  })

  it('is not live when the list cannot be read', async () => {
    const { useRoundtableLive, reportThreads } = await load()
    reportThreads([{ replying: true }])
    vi.advanceTimersByTime(15_000)
    listThreads.mockRejectedValue(new Error('offline'))
    const { wrapper, live } = host(useRoundtableLive)
    await flushPromises()
    expect(live()).toBe(false)
    wrapper.unmount()
  })

  it('reads nothing and stays still while 圆桌 is not shown, and starts once it is', async () => {
    const { useRoundtableLive, reportThreads } = await load()
    listThreads.mockResolvedValue({ threads: [{ replying: true }] })
    const enabled = ref(false)
    const { wrapper, live } = host(useRoundtableLive, enabled)
    await flushPromises()
    vi.advanceTimersByTime(15_000)
    await flushPromises()
    expect(listThreads).not.toHaveBeenCalled()
    reportThreads([{ replying: true }])
    expect(live()).toBe(false)
    enabled.value = true
    await flushPromises()
    expect(listThreads).toHaveBeenCalledTimes(1)
    expect(live()).toBe(true)
    wrapper.unmount()
  })

  it('uses what the 圆桌 page just read instead of reading again', async () => {
    const { useRoundtableLive, reportThreads } = await load()
    reportThreads([{ replying: true }])
    const { wrapper, live } = host(useRoundtableLive)
    await flushPromises()
    expect(listThreads).not.toHaveBeenCalled()
    expect(live()).toBe(true)
    reportThreads([])
    expect(live()).toBe(false)
    wrapper.unmount()
  })
})
