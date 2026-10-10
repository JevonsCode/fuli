import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson }))

import JudgmentWorkbench from './JudgmentWorkbench.vue'

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'decision-a',
    createdAt: '2026-10-11T08:00:00.000Z',
    personalProjectId: 'project-a',
    kind: 'review',
    target: 'relationship:synthetic-id',
    title: 'release checklist',
    summary: 'Needs a human release decision.',
    outcome: 'escalate',
    evidence: ['release owner is missing'],
    policy: { mode: 'manual', quality: 'quality' },
    client: 'codex',
    model: null,
    sessionId: 'session-a',
    selection: null,
    execution: { status: 'not_applied' },
    feedback: { revision: 2, vote: null, reason: '' },
    feedbackHistory: [],
    executionHistory: [],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('JudgmentWorkbench', () => {
  beforeEach(() => {
    getJson.mockReset().mockResolvedValue({ records: [record(), record({
      id: 'decision-b', outcome: 'approve', summary: 'Safe to continue.', execution: { status: 'applied' },
    })] })
    postJson.mockReset().mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url === '/api/judgment/review') return { records: [record({ id: 'decision-c', outcome: 'recommend' })], remaining: 0 }
      return { ...record(), ...body, feedback: { revision: 3, vote: body.vote, reason: body.reason ?? '' } }
    })
  })

  it('loads recent records and filters human-needed decisions', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith('/api/judgment/records?personalSpaceId=space-a')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
    await wrapper.get('[data-filter="all"]').trigger('click')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(2)
    await wrapper.get('[data-filter="human"]').trigger('click')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
    expect(wrapper.text()).toContain('release checklist')
    expect(wrapper.get('[data-decision-card] h3').text()).toBe('release checklist')
  })

  it('requests a bounded review with a fresh request ID and shows the result', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('[data-filter="all"]').trigger('click')
    await wrapper.get('[data-action="review"]').trigger('click')
    await flushPromises()

    const [url, body] = postJson.mock.calls.find(([calledUrl]) => calledUrl === '/api/judgment/review')!
    expect(url).toBe('/api/judgment/review')
    expect(body).toMatchObject({ personalSpaceId: 'space-a', limit: 10 })
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(3)
  })

  it('keeps autonomous runtime recommendations out of the human-needed queue', async () => {
    getJson.mockResolvedValueOnce({ records: [record({
      kind: 'routing', outcome: 'recommend', disposition: 'continue_current', policy: { mode: 'autonomous' },
    })] })
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(0)
    await wrapper.get('[data-filter="all"]').trigger('click')
    expect(wrapper.findAll('[data-decision-card]')).toHaveLength(1)
  })

  it('sends feedback with the current revision and recovers from a stale revision', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('[data-feedback-reason]').setValue('Keep the owner in the loop.')
    await wrapper.get('[data-feedback="up"]').trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', {
      personalSpaceId: 'space-a', decisionId: 'decision-a', vote: 'up',
      reason: 'Keep the owner in the loop.', expectedRevision: 2,
    })

    postJson.mockRejectedValueOnce({ status: 409 })
    await wrapper.get('[data-feedback="down"]').trigger('click')
    await flushPromises()
    expect(getJson.mock.calls.length).toBeGreaterThan(1)
    expect(wrapper.get('[role="alert"]').text()).toMatch(/changed|更新|重试/i)
  })

  it('does not load or review without a real personal space', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: '' } })
    await flushPromises()
    expect(getJson).not.toHaveBeenCalled()
    expect(postJson).not.toHaveBeenCalled()
    expect(wrapper.get('[data-action="review"]').attributes('disabled')).toBeDefined()
  })

  it('clears private records and drafts immediately when the personal space changes', async () => {
    const first = deferred<{ records: unknown[] }>()
    const second = deferred<{ records: unknown[] }>()
    getJson.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    first.resolve({ records: [record({ id: 'private-a', title: 'Space A decision' })] })
    await flushPromises()
    expect(wrapper.text()).toContain('Space A decision')

    await wrapper.setProps({ personalSpaceId: 'space-b' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('Space A decision')
    second.reject(new Error('Space B is unavailable'))
    await flushPromises()

    expect(wrapper.text()).not.toContain('Space A decision')
    expect(wrapper.get('[role="alert"]').text()).toContain('Space B is unavailable')
  })

  it('ignores a feedback response from a previous personal space', async () => {
    const oldResponse = deferred<ReturnType<typeof record>>()
    getJson.mockReset().mockResolvedValue({ records: [record({ id: 'private-a', title: 'Space A decision' })] })
    postJson.mockReset().mockReturnValueOnce(oldResponse.promise)
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    await wrapper.get('[data-feedback="up"]').trigger('click')
    await wrapper.setProps({ personalSpaceId: 'space-b' })
    await wrapper.vm.$nextTick()
    oldResponse.resolve(record({ id: 'private-a', title: 'Space A response' }))
    await flushPromises()

    expect(wrapper.text()).not.toContain('Space A response')
    expect(wrapper.find('[data-feedback-saving]').exists()).toBe(false)
  })

  it('seeds persisted feedback reasons, preserves them on vote, and saves edits without changing the vote', async () => {
    const persisted = record({ feedback: { revision: 2, vote: 'up', reason: 'Keep context' } })
    getJson.mockReset().mockResolvedValue({ records: [persisted] })
    postJson.mockReset().mockImplementation(async (_url: string, body: Record<string, unknown>) => ({
      ...persisted,
      feedback: { revision: 3, vote: body.vote, reason: body.reason ?? '' },
    }))
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    await wrapper.get('[data-feedback="up"]').trigger('click')
    expect(postJson).toHaveBeenCalledWith('/api/judgment/feedback', expect.objectContaining({ vote: null, reason: 'Keep context' }))

    const editor = wrapper.get('[data-feedback-editor]')
    expect((editor.element as HTMLDetailsElement).open).toBe(false)
    await editor.get('[data-feedback-toggle]').trigger('click')
    await editor.get('[data-feedback-reason]').setValue('Use the current owner.')
    await editor.get('[data-save-reason]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/judgment/feedback', expect.objectContaining({ vote: null, reason: 'Use the current owner.' }))

    await editor.get('[data-feedback-reason]').setValue('')
    await editor.get('[data-save-reason]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/judgment/feedback', expect.objectContaining({ vote: null, reason: '' }))
  })

  it('shows actual source selection and keeps receipts and session IDs behind disclosure', async () => {
    getJson.mockReset().mockResolvedValue({ records: [record({
      client: 'claude_code', model: 'claude-3', selection: { executorId: 'executor-a', model: 'claude-3', client: 'claude_code' },
      execution: { status: 'failed', receipt: { reason: 'Permission required', detail: 'private detail' } },
      sessionId: '12345678-1234-1234-1234-123456789012', error: 'Permission required',
    })] })
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()

    expect(wrapper.text()).toContain('Claude Code')
    expect(wrapper.text()).toContain('claude-3')
    expect(wrapper.text()).toContain('executor-a')
    expect(wrapper.get('.judgment-record-meta').text()).not.toContain('12345678-1234-1234-1234-123456789012')
    const details = wrapper.get('[data-judgment-details]')
    expect((details.element as HTMLDetailsElement).open).toBe(false)
    await details.get('summary').trigger('click')
    expect(details.text()).toContain('Permission required')
    expect(details.text()).toContain('12345678-1234-1234-1234-123456789012')
  })

  it('uses familiar thumbs-up and thumbs-down feedback icons', async () => {
    const wrapper = mount(JudgmentWorkbench, { props: { personalSpaceId: 'space-a' } })
    await flushPromises()
    expect(wrapper.get('[data-feedback="up"]').text()).toContain('👍')
    expect(wrapper.get('[data-feedback="down"]').text()).toContain('👎')
    expect(wrapper.get('[data-feedback="up"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.get('[data-feedback="down"]').attributes('title')).toBeTruthy()
  })
})
