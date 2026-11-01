import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type ComputedRef, type Ref } from 'vue'

const listThreads = vi.fn()
vi.mock('./roundtable-api', () => ({ listThreads: () => listThreads() }))

async function load() {
  vi.resetModules()
  return import('./roundtable-live')
}
function host(useLive: (space: Ref<string>) => ComputedRef<boolean>) {
  let live!: ComputedRef<boolean>
  const wrapper = mount(defineComponent({ setup() { live = useLive(ref('space')); return () => h('div') } }))
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
