import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./unassigned-conversations', async (importOriginal) => ({
  ...await importOriginal<typeof import('./unassigned-conversations')>(),
  readUnassignedConversations: vi.fn(async () => [
    { conversationId: 'conv-1', openingLine: 'Synthetic opening one', shortId: 'conv-1', startedAt: null, triageStatus: 'unlabeled', topic: null, suggestedProjectId: null },
    { conversationId: 'conv-2', openingLine: 'Synthetic opening two', shortId: 'conv-2', startedAt: null, triageStatus: 'unlabeled', topic: null, suggestedProjectId: null },
  ]),
}))
vi.mock('./topic-proposals', async (importOriginal) => ({
  ...await importOriginal<typeof import('./topic-proposals')>(), readTopicProposals: vi.fn(async () => []),
}))

import UnassignedConversationsPanel from './UnassignedConversationsPanel.vue'

beforeEach(() => setActivePinia(createPinia()))

describe('UnassignedConversationsPanel', () => {
  it('opens with the conversation a link names lifted, for the person to label', async () => {
    const wrapper = mount(UnassignedConversationsPanel, { props: { spaceId: 'space-1', formalProjects: [], existingProjectIds: [],
      focusConversationId: 'conv-2' } })
    await flushPromises()
    const rows = wrapper.findAll('[data-unassigned-item]')
    expect(rows.map(row => row.attributes('aria-current') ?? null)).toEqual([null, 'true'])
    expect(rows[1].classes()).toContain('shadow-md')
    expect(rows[0].classes()).not.toContain('shadow-md')
  })
})
