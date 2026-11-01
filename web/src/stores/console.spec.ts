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

  it('sends explicit client capture choices together without lifting the other restriction', async () => {
    const sources = { disabledSources: ['other'], capturedSources: ['opencode'] }
    patchJson.mockResolvedValue({ enabled: true, ...sources })
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, disabledSources: ['other'] } }
    await store.updateCapturePolicy(true, sources)
    expect(patchJson).toHaveBeenCalledWith('/api/capture-policy', { enabled: true, ...sources })
    expect(store.state.capturePolicy?.disabledSources).toEqual(['other'])
    expect(store.state.capturePolicy?.capturedSources).toEqual(['opencode'])
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

  it('sends overlapping saves one after another, so the last answer holds every change (dot review P2, PR 262)', async () => {
    // The server applies each save to what it holds and answers with the result.
    let saved: string[] = []
    const answers: Array<() => void> = []
    patchJson.mockImplementation((_url: string, change: { recordProjects: Record<string, boolean> }) =>
      new Promise(resolve => answers.push(() => {
        for (const [id, recorded] of Object.entries(change.recordProjects)) {
          saved = recorded ? saved.filter(item => item !== id) : [...new Set([...saved, id])].sort()
        }
        resolve({ enabled: true, projectMode: 'all_except', excludedProjectIds: saved })
      })))
    let answerRead!: (value: unknown) => void
    getJson.mockReturnValueOnce(new Promise(resolve => { answerRead = resolve }))
    saved = ['a']
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] } }

    const read = store.loadCapturePolicy()
    // S1 turns a back on; S2, from another page, turns b off while S1 is still out.
    const first = store.changeCapturePolicy({ recordProjects: { a: true } })
    const second = store.changeCapturePolicy({ recordProjects: { b: false } })
    await Promise.resolve()
    expect(patchJson).toHaveBeenCalledTimes(1)
    // S2 cannot commit before S1: it is sent only once S1 is answered.
    answers[0]()
    await first
    await vi.waitFor(() => expect(patchJson).toHaveBeenCalledTimes(2))
    answers[1]()
    await second
    answerRead({ enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] })
    await read
    expect(saved).toEqual(['b'])
    expect(store.state.capturePolicy?.excludedProjectIds).toEqual(['b'])
  })

  it('when a later save fails after an earlier one succeeded, the console reads what is saved (dot review P2, PR 262)', async () => {
    let answerFirst!: (value: unknown) => void
    patchJson.mockReturnValueOnce(new Promise(resolve => { answerFirst = resolve }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    getJson.mockResolvedValue({ enabled: true, projectMode: 'all_except', excludedProjectIds: [] })
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] } }

    const first = store.changeCapturePolicy({ recordProjects: { a: true } })
    const second = store.changeCapturePolicy({ recordProjects: { b: false } })
    const secondFailed = expect(second).rejects.toThrow('Failed to fetch')
    // Whatever order the network would give, S1 is answered before S2 can fail.
    await new Promise(resolve => setTimeout(resolve, 0))
    answerFirst({ enabled: true, projectMode: 'all_except', excludedProjectIds: [] })
    await first
    await secondFailed
    await vi.waitFor(() => expect(getJson).toHaveBeenCalledWith('/api/capture-policy'))
    await vi.waitFor(() => expect(store.state?.capturePolicy?.excludedProjectIds).toEqual([]))
  })

  it('a settled read waits for every save out and returns the settings it read (dot review, PR 262)', async () => {
    let answerSave!: (value: unknown) => void
    patchJson.mockReturnValueOnce(new Promise(resolve => { answerSave = resolve }))
    getJson.mockResolvedValue({ enabled: true, projectMode: 'all_except', excludedProjectIds: [] })
    const store = useConsoleStore()
    store.state = { mode: 'personal_only', personalSpaces: [], projects: [], subscriptions: [],
      capturePolicy: { enabled: true, projectMode: 'all_except', excludedProjectIds: ['a'] } }
    const save = store.changeCapturePolicy({ recordProjects: { a: true } })
    let settled: unknown = null
    const read = store.settledCapturePolicy().then(policy => { settled = policy })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getJson).not.toHaveBeenCalled()
    expect(settled).toBeNull()
    answerSave({ enabled: true, projectMode: 'all_except', excludedProjectIds: [] })
    await save
    await read
    expect(settled).toEqual({ enabled: true, projectMode: 'all_except', excludedProjectIds: [] })
    expect(store.state.capturePolicy?.excludedProjectIds).toEqual([])
  })

  it('ignores a superseded scope failure and aborts its transport', async () => {
    let fail!: (cause: unknown) => void
    const pending = new Promise((_resolve, reject) => { fail = reject })
    getJson.mockReturnValueOnce(pending).mockResolvedValueOnce({ personalSpaces: [{ id: 'fresh' }], activePersonalSpaceId: 'fresh' })
    const store = useConsoleStore()
    const old = store.refresh()
    const signal = getJson.mock.calls[0]![2].signal
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
