import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, postJson }))

import { useConsoleStore } from '@/stores/console'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import ReviewPage from './ReviewPage.vue'

describe('ReviewPage', () => {
  beforeEach(() => {
    getJson.mockReset()
    getJson.mockImplementation((url: string) => {
      if (url.startsWith('/api/personal-review?')) {
        return Promise.resolve({
          drafts: [{
            id: 'draft/1',
            created_at: '2026-07-31T00:00:00Z',
            episode: {
              name: '发布规则',
              summary: '所有发布都需要审核。',
              entities: [{}],
              relationships: [],
            },
          }],
        })
      }
      return Promise.resolve({
        proposals: [{
          id: 'proposal/1',
          created_at: '2026-07-31T00:00:00Z',
          episode: {
            name: '共享发布规则',
            summary: '把发布审核规则同步到项目。',
          },
        }],
      })
    })
    postJson.mockReset()
    postJson.mockResolvedValue({})
  })

  it('loads and decides personal and Maintainer review queues through current APIs', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useConsoleStore()
    store.state = {
      mode: 'connected',
      activePersonalSpaceId: 'personal-1',
      personalSpaces: [{ id: 'personal-1', name: '我' }],
      personalProjects: [],
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
    }
    vi.spyOn(store, 'refresh').mockResolvedValue(undefined)
    const wrapper = mount(ReviewPage, {
      global: {
        plugins: [pinia],
        stubs: { SearchableSelect: SearchableSelectStub },
      },
    })
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
})
