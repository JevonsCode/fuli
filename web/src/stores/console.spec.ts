import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson }))

import { useConsoleStore } from './console'

describe('console store policies', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    setActivePinia(createPinia())
    getJson.mockReset()
    patchJson.mockReset()
  })

  it('persists capture policy changes and keeps existing knowledge semantics visible', async () => {
    patchJson.mockResolvedValue({
      enabled: false,
      updatedAt: '2026-07-31T00:00:00Z',
    })
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      projects: [],
      subscriptions: [],
      capturePolicy: { enabled: true },
    }

    await store.updateCapturePolicy(false)

    expect(patchJson).toHaveBeenCalledWith('/api/capture-policy', { enabled: false })
    expect(store.state.capturePolicy?.enabled).toBe(false)
    expect(store.feedback?.message).toContain('已有知识仍可读取')
  })

  it('leaves the persisted policy unchanged when saving fails, and reads it again', async () => {
    patchJson.mockRejectedValue(new Error('save failed'))
    getJson.mockResolvedValue({ enabled: true, updatedAt: null })
    const store = useConsoleStore()
    store.state = {
      mode: 'personal_only',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      projects: [],
      subscriptions: [],
      capturePolicy: { enabled: true },
    }

    await store.updateCapturePolicy(false)

    expect(store.state.capturePolicy?.enabled).toBe(true)
    expect(store.feedback).toEqual({ message: 'save failed', tone: 'error' })
    expect(getJson).toHaveBeenCalledWith('/api/capture-policy')
  })

  it('drops a read that started while a save was in flight and answered after it (dot review P2-2, PR 262)', async () => {
    let answerSave!: (value: unknown) => void
    patchJson.mockReturnValueOnce(new Promise(resolve => { answerSave = resolve }))
    let answerRead!: (value: unknown) => void
    getJson.mockReturnValueOnce(new Promise(resolve => { answerRead = resolve }))
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] } }

    const save = store.changeCapturePolicy({ recordProjects: { a: true } })
    const read = store.loadCapturePolicy()
    answerSave({ enabled: true, projectMode: 'all_except', excludedProjectIds: [] })
    await save
    // The read left before the save landed; its older answer arrives last.
    answerRead({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] })
    await read
    expect(store.state.capturePolicy?.excludedProjectIds).toEqual([])
  })

  it('keeps only the latest capture save and drops a read that a save overtook (rec#5 C4-4)', async () => {
    let answerFirst!: (value: unknown) => void
    patchJson.mockReturnValueOnce(new Promise(resolve => { answerFirst = resolve }))
      .mockResolvedValueOnce({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['a', 'b'] })
    let answerRead!: (value: unknown) => void
    getJson.mockReturnValueOnce(new Promise(resolve => { answerRead = resolve }))
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [], capturePolicy: { enabled: true } }

    const read = store.loadCapturePolicy()
    const first = store.changeCapturePolicy({ recordProjects: { a: false } })
    await store.changeCapturePolicy({ recordProjects: { b: false } })
    answerFirst({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] })
    answerRead({ enabled: true })
    await Promise.all([first, read])
    expect(store.state.capturePolicy?.excludedProjectIds).toEqual(['a', 'b'])
  })

  it('ignores a superseded scope failure and aborts its transport', async () => {
    let fail!: (cause: unknown) => void
    const pending = new Promise((_resolve, reject) => { fail = reject })
    getJson.mockReturnValueOnce(pending).mockResolvedValueOnce({ personalSpaces: [{ id: 'fresh' }], activePersonalSpaceId: 'fresh' })
    const store = useConsoleStore()
    const old = store.refresh()
    const signal = getJson.mock.calls[0]![1].signal
    await store.refresh()
    expect(signal.aborted).toBe(true)
    fail(Object.assign(new Error('old denied'), { status: 403 })); await old
    expect(store.activePersonalSpace?.id).toBe('fresh')
    expect(store.runtimeStatus).toBe('ready')
  })

  it('keeps cached scope for 503, clears it for 401 and never renders the response body', async () => {
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [{ id: 'private', name: 'Private space' }], projects: [], subscriptions: [] }
    getJson.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 }))
    await store.refresh()
    expect(store.state).not.toBeNull()
    getJson.mockRejectedValueOnce(Object.assign(new Error('private response body'), { status: 401 }))
    await store.refresh()
    expect(store.state).toBeNull()
    expect(store.feedback?.message).not.toContain('private response body')
  })

  it('ends a hung scope read at 30 seconds and ignores its eventual success', async () => {
    vi.useFakeTimers()
    let resolve!: (value: unknown) => void
    getJson.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const store = useConsoleStore(), pending = store.refresh()
    await vi.advanceTimersByTimeAsync(30000)
    await pending
    expect(store.runtimeStatus).toBe('error')
    expect(store.refreshError).toBe('timeout')
    resolve({ personalSpaces: [{ id: 'late' }], activePersonalSpaceId: 'late' }); await Promise.resolve()
    expect(store.state).toBeNull()
  })
})
