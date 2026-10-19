import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import panelSource from './UnassignedConversationsPanel.vue?raw'
import {
  ASSISTANT_AGENT_ID,
  readUnassignedConversations,
  triageUnassignedConversation,
} from './unassigned-conversations'

const { postJson } = vi.hoisted(() => ({ postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, postJson }
})

describe('unassigned conversations reader and triage', () => {
  beforeEach(() => {
    postJson.mockReset()
  })

  it('never shows an ID as the title and tells untitled conversations apart by a short ID', async () => {
    postJson.mockResolvedValue({ conversations: [
      { id: '3f1a2b3c-aaaa-4bbb-8ccc-000000000001', title: '3f1a2b3c-aaaa-4bbb-8ccc-000000000001' },
      { id: '3f1a2b3c-aaaa-4bbb-8ccc-000000000002' },
      { id: 'b7c8d9e0-1111-4222-8333-444455556666', summary: 'Fix the header padding' },
    ] })
    const items = await readUnassignedConversations('space-1')
    expect(items.map(item => item.openingLine)).toEqual(['', '', 'Fix the header padding'])
    // The first two share 8 and 12 characters, so they keep their full IDs.
    expect(items.map(item => item.shortId)).toEqual(['3f1a2b3c-aaaa-4bbb-8ccc-000000000001', '3f1a2b3c-aaaa-4bbb-8ccc-000000000002', 'b7c8d9e0'])
    expect(items[0].conversationId).toBe('3f1a2b3c-aaaa-4bbb-8ccc-000000000001')
    expect(panelSource).toMatch(/agentRedesign.unassigned.untitled/)
  })

  it('lists global-scope employee.assistant conversations and extracts opening line and Jefa triage state', async () => {
    postJson.mockResolvedValue({
      conversations: [
        {
          id: 'conv-1',
          summary: 'How do we wire the new agent pages?\nSecond line',
          status: 'reported',
          last_activity: '2026-10-18T02:00:00Z',
          triage: { kind: 'topic', topic: 'Agent 页面重构', source: 'host' },
        },
        {
          id: 'conv-one-off',
          summary: 'Already triaged as one-off by user',
          status: 'reported',
          last_activity: '2026-10-18T01:00:00Z',
          triage: { kind: 'one_off', source: 'user' },
        },
      ],
    })

    const items = await readUnassignedConversations('space-a')
    expect(postJson).toHaveBeenCalledWith('/api/agent-conversations/query', {
      personalSpaceId: 'space-a',
      personalProjectId: null,
      agentId: ASSISTANT_AGENT_ID,
      mode: 'list',
      limit: 50,
    })
    expect(items).toEqual([
      expect.objectContaining({
        conversationId: 'conv-1',
        openingLine: 'How do we wire the new agent pages?',
        triageStatus: 'needs_project',
        topic: 'Agent 页面重构',
        startedAt: '2026-10-18T02:00:00Z',
      }),
    ])
  })

  it('returns an empty list when employee.assistant has not been provisioned yet (404)', async () => {
    postJson.mockRejectedValue(new ApiError('project Agent not found', 404))
    await expect(readUnassignedConversations('space-a')).resolves.toEqual([])
  })

  it('posts user triage corrections to /api/conversation-triage/record with source: user', async () => {
    postJson.mockResolvedValue({ triage: { kind: 'project', personal_project_id: 'project-formal', source: 'user' } })
    await triageUnassignedConversation({
      personalSpaceId: 'space-a',
      conversationId: 'conv-1',
      kind: 'project',
      personalProjectId: 'project-formal',
    })
    expect(postJson).toHaveBeenCalledWith('/api/conversation-triage/record', {
      personalSpaceId: 'space-a',
      conversationId: 'conv-1',
      kind: 'project',
      personalProjectId: 'project-formal',
      topic: null,
      source: 'user',
    })
  })
})

// The panel also renders inside Astro's workbench, which does not load the
// Agents directory stylesheet; without its own copy the chevron rendered unsized.
describe('UnassignedConversationsPanel styles', () => {
  it('loads its stylesheet wherever it renders', () => {
    expect(panelSource).toContain('<style src="./agent-profile.css" />')
  })
})
