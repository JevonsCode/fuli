import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ unassigned: vi.fn() }))
vi.mock('./unassigned-conversations', async (importOriginal) => ({
  ...await importOriginal<typeof import('./unassigned-conversations')>(), readUnassignedConversations: reads.unassigned,
}))
vi.mock('./topic-proposals', async (importOriginal) => ({
  ...await importOriginal<typeof import('./topic-proposals')>(), readTopicProposals: vi.fn(async () => []),
}))

import UnassignedConversationsPanel from './UnassignedConversationsPanel.vue'

// Synthetic conversations only.
const item = (conversationId: string) => ({ conversationId, openingLine: `Synthetic opening ${conversationId}`, shortId: conversationId,
  startedAt: null, triageStatus: 'pending', topic: null, suggestedProjectId: null })

beforeEach(() => {
  setActivePinia(createPinia())
  reads.unassigned.mockResolvedValue({ items: [item('conv-1'), item('conv-2')], resolvedIds: ['conv-9'] })
})

const mountPanel = async (focusConversationId: string) => {
  const wrapper = mount(UnassignedConversationsPanel, { props: { spaceId: 'space-1', formalProjects: [], existingProjectIds: [],
    focusConversationId } })
  await flushPromises()
  return wrapper
}

describe('UnassignedConversationsPanel', () => {
  it('opens with the conversation a link names lifted, for the person to label', async () => {
    const wrapper = await mountPanel('conv-2')
    const rows = wrapper.findAll('[data-unassigned-item]')
    expect(rows.map(row => row.attributes('aria-current') ?? null)).toEqual([null, 'true'])
    expect(rows[1]!.classes()).toContain('shadow-md')
    expect(wrapper.find('[data-unassigned-focus]').exists()).toBe(false)
  })

  it('says a linked conversation is labeled only when the read shows it; otherwise that it cannot be read now', async () => {
    expect((await mountPanel('conv-9')).get('[data-unassigned-focus]').text()).toBe('这段对话已归类。')
    expect((await mountPanel('conv-unlisted')).get('[data-unassigned-focus]').text()).toBe('暂时无法读取这段对话。')
    reads.unassigned.mockRejectedValue(new Error('HTTP 403'))
    expect((await mountPanel('conv-9')).find('[data-unassigned-focus]').exists()).toBe(false)
  })
})
