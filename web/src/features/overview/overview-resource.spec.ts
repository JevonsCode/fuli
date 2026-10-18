import { effectScope } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { overviewResource } from './overview-resource'

afterEach(() => vi.useRealTimers())
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
describe('bounded workbench reads', () => {
  it('keeps one effective round, marks slow, ends at 30s and ignores late success', async () => {
    vi.useFakeTimers()
    const scope = effectScope()
    const resource = scope.run(() => overviewResource<string>())!
    const pending = deferred<string>()
    const read = vi.fn(() => pending.promise)
    const first = resource.load(read)
    await resource.load(read)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(8000)
    expect(resource.state.slow).toBe(true)
    await vi.advanceTimersByTimeAsync(22000)
    await first
    expect(resource.state.loading).toBe(false)
    expect(resource.state.error).toBe('timeout')
    pending.resolve('too late'); await Promise.resolve()
    expect(resource.state.data).toBeNull()
    scope.stop()
  })
  it('retains the last successful result for ordinary failure and clears on permission failure', async () => {
    const scope = effectScope()
    const denied = vi.fn()
    const resource = scope.run(() => overviewResource<string>(denied))!
    await resource.load(async () => 'old')
    const time = resource.state.updatedAt
    await resource.load(async () => { throw Object.assign(new Error('offline'), { status: 503 }) })
    expect(resource.state.data).toBe('old')
    expect(resource.state.updatedAt).toBe(time)
    await resource.load(async () => { throw Object.assign(new Error('private body'), { status: 403 }) })
    expect(resource.state.data).toBeNull()
    expect(resource.state.error).toBe('denied')
    expect(denied).toHaveBeenCalledTimes(1)
    scope.stop()
  })
  it('aborts on reset/unmount and cannot publish an old-space result or error', async () => {
    const scope = effectScope()
    const resource = scope.run(() => overviewResource<string>())!
    const pending = deferred<string>()
    let signal!: AbortSignal
    const old = resource.load(value => { signal = value; return pending.promise })
    resource.reset()
    expect(signal.aborted).toBe(true)
    await resource.load(async () => 'new space')
    pending.resolve('old space'); await old
    expect(resource.state.data).toBe('new space')
    const next = resource.load(() => new Promise(() => {}))
    scope.stop(); await next
    expect(resource.state.loading).toBe(false)
  })
})
