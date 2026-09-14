import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, postJson }))

import { useConsoleStore } from '@/stores/console'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import ReviewPage from './ReviewPage.vue'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function draft(id: string, name: string): object {
  return {
    id,
    created_at: '2026-07-31T00:00:00Z',
    episode: {
      name,
      summary: name + '摘要。',
      entities: [{}],
      relationships: [],
    },
  }
}

function proposal(id: string, name: string): object {
  return {
    id,
    created_at: '2026-07-31T00:00:00Z',
    episode: {
      name,
      summary: name + '摘要。',
    },
  }
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'connected',
    activePersonalSpaceId: 'personal-1',
    personalSpaces: [{ id: 'personal-1', name: '我' }],
    personalProjects: [],
    providers: {
      personal: { status: 'ready' },
      workspaces: [{
        status: 'ready',
        providerUrl: 'https://provider.example',
        capabilities: { reviewProposals: true },
      }],
    },
    projects: [{
      id: 'project-1',
      name: '项目一',
      providerUrl: 'https://provider.example',
      role: 'maintainer',
    }],
    subscriptions: [],
    capabilities: {
      submitKnowledge: true,
      reviewProposals: true,
    },
    ...overrides,
  }
}

function mountReview() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.state = state()
  const refresh = vi.spyOn(store, 'refresh').mockResolvedValue(undefined)
  const wrapper = mount(ReviewPage, {
    global: {
      plugins: [pinia],
      stubs: { SearchableSelect: SearchableSelectStub },
    },
  })
  return { store, refresh, wrapper }
}

describe('ReviewPage', () => {
  beforeEach(() => {
    getJson.mockReset()
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/personal-review?')) {
        return Promise.resolve({ drafts: [draft('draft/1', '发布规则')] })
      }
      return Promise.resolve({ proposals: [proposal('proposal/1', '共享发布规则')] })
    })
    postJson.mockReset()
    postJson.mockResolvedValue({})
  })

  it('loads and decides personal and Maintainer review queues through current APIs', async () => {
    const { wrapper } = mountReview()
    await flushPromises()

    expect(wrapper.text()).toContain('发布规则')
    expect(wrapper.text()).toContain('共享发布规则')

    const personalDecision = wrapper
      .findAll('.review-item button')
      .find((button) => button.text() === '提交公共')
    expect(personalDecision).toBeDefined()
    await personalDecision!.trigger('click')
    await flushPromises()

    const sharedDecision = wrapper
      .findAll('.review-item button')
      .find((button) => button.text() === '通过')
    expect(sharedDecision).toBeDefined()
    await sharedDecision!.trigger('click')
    await flushPromises()

    expect(postJson).toHaveBeenCalledWith(
      '/api/personal-review/draft%2F1/decision',
      { decision: 'submit_public' },
    )
    expect(postJson).toHaveBeenCalledWith(
      '/api/review/proposal%2F1/decision',
      {
        projectId: 'project-1',
        providerUrl: 'https://provider.example',
        decision: 'approve',
        note: null,
      },
    )
  })

  it('ignores stale personal responses and clears drafts when the active space is removed', async () => {
    const personalOne = deferred<{ drafts?: object[] }>()
    const personalTwo = deferred<{ drafts?: object[] }>()
    const signals: AbortSignal[] = []
    getJson.mockImplementation((url: string, init?: { signal?: AbortSignal }) => {
      if (!url.startsWith('/api/personal-review?')) return Promise.resolve({ proposals: [] })
      const spaceId = new URLSearchParams(url.split('?')[1]).get('personalSpaceId')
      if (init?.signal) signals.push(init.signal)
      return spaceId === 'space-two' ? personalTwo.promise : personalOne.promise
    })

    const { store, wrapper } = mountReview()
    store.state = state({
      activePersonalSpaceId: 'space-one',
      personalSpaces: [{ id: 'space-one', name: '一' }, { id: 'space-two', name: '二' }],
    })
    await flushPromises()
    expect(signals).toHaveLength(2)

    store.state = state({
      activePersonalSpaceId: 'space-two',
      personalSpaces: [{ id: 'space-one', name: '一' }, { id: 'space-two', name: '二' }],
    })
    await flushPromises()
    personalTwo.resolve({ drafts: [draft('draft-two', '新空间草稿')] })
    await flushPromises()
    expect(wrapper.text()).toContain('新空间草稿')

    personalOne.resolve({ drafts: [draft('draft-one', '旧空间草稿')] })
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧空间草稿')
    expect(signals[0]?.aborted).toBe(true)

    store.state = state({ activePersonalSpaceId: null, personalSpaces: [] })
    await flushPromises()
    expect(wrapper.text()).not.toContain('新空间草稿')
  })

  it('clears stale proposals on project changes and never posts the old proposal to the new project', async () => {
    const projectOne = deferred<{ proposals?: object[] }>()
    let projectTwoLoaded!: (value: { proposals?: object[] }) => void
    const projectTwo = new Promise<{ proposals?: object[] }>((resolve) => { projectTwoLoaded = resolve })
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/personal-review?')) return Promise.resolve({ drafts: [] })
      const projectId = new URLSearchParams(url.split('?')[1]).get('projectId')
      return projectId === 'project-1' ? projectOne.promise : projectTwo
    })

    const { store, wrapper } = mountReview()
    store.state = state({
      projects: [
        {
          id: 'project-1',
          name: '项目一',
          providerUrl: 'https://provider.example',
          role: 'maintainer',
        },
        {
          id: 'project-2',
          name: '项目二',
          providerUrl: 'https://provider.example',
          role: 'maintainer',
        },
      ],
    })
    await flushPromises()
    projectOne.resolve({ proposals: [proposal('proposal-old', '旧项目 Proposal')] })
    await flushPromises()
    const oldApprove = wrapper.get('[data-review-queue="shared"] .approve')

    await wrapper.get('[aria-label="审核项目"]').setValue('project-2')
    expect(wrapper.text()).not.toContain('旧项目 Proposal')
    oldApprove.element.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(postJson).not.toHaveBeenCalledWith(
      '/api/review/proposal-old/decision',
      expect.anything(),
    )

    projectTwoLoaded({ proposals: [proposal('proposal-new', '新项目 Proposal')] })
    await flushPromises()
    expect(wrapper.text()).toContain('新项目 Proposal')
    expect(wrapper.text()).not.toContain('旧项目 Proposal')
  })

  it('ignores a shared response that belongs to the previous project', async () => {
    const projectOne = deferred<{ proposals?: object[] }>()
    const projectTwo = deferred<{ proposals?: object[] }>()
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/personal-review?')) return Promise.resolve({ drafts: [] })
      const projectId = new URLSearchParams(url.split('?')[1]).get('projectId')
      return projectId === 'project-1' ? projectOne.promise : projectTwo.promise
    })

    const { store, wrapper } = mountReview()
    store.state = state({
      projects: [
        {
          id: 'project-1',
          name: '项目一',
          providerUrl: 'https://provider.example',
          role: 'maintainer',
        },
        {
          id: 'project-2',
          name: '项目二',
          providerUrl: 'https://provider.example',
          role: 'maintainer',
        },
      ],
    })
    await flushPromises()
    await wrapper.get('[aria-label="审核项目"]').setValue('project-2')
    projectTwo.resolve({ proposals: [proposal('proposal-new', '新项目 Proposal')] })
    await flushPromises()
    projectOne.resolve({ proposals: [proposal('proposal-old', '旧项目 Proposal')] })
    await flushPromises()

    expect(wrapper.text()).toContain('新项目 Proposal')
    expect(wrapper.text()).not.toContain('旧项目 Proposal')
  })

  it('reloads both queues after a same-scope state refresh and disables old decisions while loading', async () => {
    let personalCalls = 0
    let sharedCalls = 0
    const sharedReload = deferred<{ proposals?: object[] }>()
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/personal-review?')) {
        personalCalls += 1
        return Promise.resolve({ drafts: [draft('draft-' + personalCalls, '刷新后草稿 ' + personalCalls)] })
      }
      sharedCalls += 1
      return sharedCalls === 1
        ? Promise.resolve({ proposals: [proposal('proposal-old', '刷新前 Proposal')] })
        : sharedReload.promise
    })

    const { store, wrapper } = mountReview()
    await flushPromises()
    expect(personalCalls).toBe(1)
    expect(sharedCalls).toBe(1)

    store.state = state()
    await flushPromises()
    expect(personalCalls).toBe(2)
    expect(sharedCalls).toBe(2)
    expect(wrapper.text()).toContain('刷新前 Proposal')
    expect(wrapper.get('[data-review-queue="shared"] .approve').attributes('disabled')).toBeDefined()

    sharedReload.resolve({ proposals: [proposal('proposal-new', '刷新后 Proposal')] })
    await flushPromises()
    expect(wrapper.text()).toContain('刷新后 Proposal')
    expect(wrapper.text()).not.toContain('刷新前 Proposal')
  })

  it('allows only one in-flight decision per proposal when the user double-clicks', async () => {
    const decision = deferred<object>()
    postJson.mockReturnValue(decision.promise)
    const { wrapper } = mountReview()
    await flushPromises()

    const approve = wrapper.get('[data-review-queue="shared"] .approve')
    const approveElement = approve.element as HTMLButtonElement
    approveElement.click()
    approveElement.click()
    await Promise.resolve()
    expect(postJson).toHaveBeenCalledTimes(1)

    decision.resolve({})
    await flushPromises()
  })

  it('names each pending queue and removes its animation independently when the response arrives', async () => {
    const personal = deferred<object>()
    const shared = deferred<object>()
    getJson.mockImplementation((url: string) => url.startsWith('/api/personal-review?')
      ? personal.promise : shared.promise)
    const { wrapper } = mountReview()
    await flushPromises()
    expect(wrapper.get('[data-review-queue="personal"] .growth-loading').text()).toContain('待确认的个人知识')
    expect(wrapper.get('[data-review-queue="shared"] .growth-loading').text()).toContain('待审核 Proposal')
    personal.resolve({ drafts: [] })
    await flushPromises()
    expect(wrapper.find('[data-review-queue="personal"] .growth-loading').exists()).toBe(false)
    expect(wrapper.find('[data-review-queue="shared"] .growth-loading').exists()).toBe(true)
    shared.resolve({ proposals: [] })
    await flushPromises()
    expect(wrapper.find('.growth-loading').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows a queue error with retry instead of claiming the queue is empty', async () => {
    let sharedAttempts = 0
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/personal-review?')) return Promise.resolve({ drafts: [] })
      sharedAttempts += 1
      return sharedAttempts === 1
        ? Promise.reject(new Error('provider unavailable'))
        : Promise.resolve({ proposals: [proposal('proposal-retry', '重试后的 Proposal')] })
    })

    const { wrapper } = mountReview()
    await flushPromises()
    const queue = wrapper.get('[data-review-queue="shared"]')
    expect(queue.get('[role="alert"]').text()).toContain('provider unavailable')
    expect(queue.find('.empty-state').exists()).toBe(false)

    await queue.get('button').trigger('click')
    await flushPromises()
    expect(queue.text()).toContain('重试后的 Proposal')
    expect(queue.find('[role="alert"]').exists()).toBe(false)
  })

  it('filters review projects by each provider capability', async () => {
    const { store, wrapper } = mountReview()
    store.state = state({
      projects: [{
        id: 'project-unsupported',
        name: '不支持审核的项目',
        providerUrl: 'https://unsupported.example',
        role: 'maintainer',
      }],
      providers: {
        personal: { status: 'ready' },
        workspaces: [{
          status: 'ready',
          providerUrl: 'https://unsupported.example',
          capabilities: { reviewProposals: false },
        }],
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-review-queue="shared"]').exists()).toBe(false)
  })
})
