import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
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
