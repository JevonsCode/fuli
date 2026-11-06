import { mount, RouterLinkStub } from '@vue/test-utils'
import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'

const attention = reactive({ total: 0, previewItems: [] as { requestId: string, title: string }[] })
const review = reactive({ total: 0, list: { questions: [] as unknown[], pending: [] as unknown[], confirmed: [] } })
vi.mock('@/features/project-agents/attention-store', () => ({ useAgentAttention: () => attention }))
vi.mock('@/features/review-list/review-store', () => ({ useReviewList: () => review }))

const { default: InboxPeek } = await import('./InboxPeek.vue')
const mountPeek = () => mount(InboxPeek, { global: { stubs: { RouterLink: RouterLinkStub } } })
const line = (key: string, text: string, question: string | null = null) => ({ key, text, review: question ? { question } : null })

describe('InboxPeek', () => {
  it('lists the first three waiting things, requests first, and links to the rest', () => {
    attention.total = 1
    attention.previewItems = [{ requestId: 'r1', title: 'Synthetic request' }]
    review.total = 4
    review.list.questions = [line('q1', 'Synthetic fact', 'Keep the synthetic fact?')]
    review.list.pending = [line('p1', 'Pending one'), line('p2', 'Pending two'), line('p3', 'Pending three')]
    const wrapper = mountPeek()
    expect(wrapper.findAll('[data-inbox-peek-line]').map(row => row.find('.header-peek-text').text()))
      .toEqual(['Synthetic request', 'Keep the synthetic fact?', 'Pending one'])
    expect(wrapper.get('[data-inbox-peek-count]').text()).toBe('5 件')
    expect(wrapper.get('[data-inbox-peek-go]').text()).toBe('还有 2 件，去处理')
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toBe('/inbox')
  })

  it('says plainly when nothing waits, with no link', () => {
    attention.total = 0
    attention.previewItems = []
    review.total = 0
    review.list.questions = []
    review.list.pending = []
    const wrapper = mountPeek()
    expect(wrapper.find('[data-inbox-peek-empty]').exists()).toBe(true)
    expect(wrapper.find('[data-inbox-peek-go]').exists()).toBe(false)
    expect(wrapper.find('[data-inbox-peek-count]').exists()).toBe(false)
  })
})
