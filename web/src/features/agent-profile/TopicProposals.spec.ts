import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { routeLocationKey } from 'vue-router'
import TopicProposals from './TopicProposals.vue'
import type { UnassignedConversationItem } from './unassigned-conversations'

const { getJson, postJson } = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return { ...actual, getJson, postJson }
})

const item = (conversationId: string, topic: string | null, openingLine: string) => ({
  conversationId, openingLine, shortId: conversationId, startedAt: null,
  triageStatus: 'needs_project', topic, suggestedProjectId: null,
}) as UnassignedConversationItem

const render = () => mount(TopicProposals, {
  props: { spaceId: 'space-a', items: [item('c1', 'Garden', 'Plan the beds'), item('c2', 'garden', 'Order seeds'),
    item('c3', 'Taxes', 'File the return')] },
  global: { stubs: { RouterLink: RouterLinkStub } },
})

const renderPromoted = () => mount(TopicProposals, {
  props: { spaceId: 'space-a', items: [] },
  global: { stubs: { RouterLink: RouterLinkStub },
    provide: { [routeLocationKey as symbol]: { query: { promoted: 'garden', topic: 'Garden' } } } },
})

describe('Astro topic proposals', () => {
  beforeEach(() => {
    getJson.mockReset()
    postJson.mockReset()
    getJson.mockResolvedValue({ proposals: [{ topic: 'Garden', conversations: 3, days: 2 }] })
  })

  it('asks with the count, the days and what the topic has been about', async () => {
    const wrapper = render()
    await flushPromises()
    expect(getJson).toHaveBeenCalledWith('/api/topic-proposals?personalSpaceId=space-a', expect.objectContaining({ schema: expect.anything() }))
    const card = wrapper.get('[data-topic-proposal]')
    expect(card.text()).toContain('Garden')
    expect(card.text()).toMatch(/3.*2/)
    expect(card.findAll('.topic-proposal-samples li').map(li => li.text())).toEqual(['Plan the beds', 'Order seeds'])
  })

  it('forms the project only when the person accepts, then links to its people', async () => {
    postJson.mockResolvedValue({ personal_project_id: 'garden', topic: 'Garden', lead_agent_id: 'lead',
      lead_status: 'ready', conversations: 3 })
    const wrapper = render()
    await flushPromises()
    expect(postJson).not.toHaveBeenCalled()
    await wrapper.get('[data-topic-accept]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/topic-proposals/accept', { personalSpaceId: 'space-a', topic: 'Garden' }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.find('[data-topic-proposal]').exists()).toBe(false)
    expect(wrapper.get('[data-topic-formed]').findComponent(RouterLinkStub).props('to'))
      .toEqual({ path: '/project-agents', query: { project: 'garden' } })
    expect(wrapper.emitted('formed')?.[0]?.[0]).toMatchObject({ personal_project_id: 'garden' })
  })

  it('records not yet and keeps the card when a reply fails', async () => {
    postJson.mockRejectedValueOnce(new Error('offline'))
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-topic-decline]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-topic-proposal]').exists()).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('Garden')
    postJson.mockResolvedValueOnce({ declined_count: 3, ask_again_at: 6 })
    await wrapper.get('[data-topic-decline]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenLastCalledWith('/api/topic-proposals/decline', { personalSpaceId: 'space-a', topic: 'Garden' }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.find('[data-topic-proposal]').exists()).toBe(false)
    expect(wrapper.find('[data-topic-declined]').exists()).toBe(true)
  })

  it('opens on a project Astro formed by itself, links to rename or move it, and undoes it (D-86)', async () => {
    getJson.mockResolvedValue({ proposals: [] })
    postJson.mockResolvedValue({ project_archived: true, conversations: 3, ask_again_at: 6,
      knowledge_returned: 4, knowledge_kept: 1 })
    const wrapper = renderPromoted()
    await flushPromises()
    const card = wrapper.get('[data-topic-promoted]')
    expect(card.text()).toContain('Garden')
    expect(card.findComponent(RouterLinkStub).props('to')).toBe('/personal/space-a/projects/garden/directory')
    await card.get('[data-topic-promoted-undo]').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/topic-proposals/undo',
      { personalSpaceId: 'space-a', topic: 'Garden', personalProjectId: 'garden' }, expect.objectContaining({ schema: expect.anything() }))
    expect(wrapper.find('[data-topic-promoted]').exists()).toBe(false)
    expect(wrapper.get('[data-topic-undone]').text()).toContain('归档')
    expect(wrapper.get('[data-topic-undone]').text()).toContain('4 条知识已回到原会话暂存；1 条之后改过')
  })
})
