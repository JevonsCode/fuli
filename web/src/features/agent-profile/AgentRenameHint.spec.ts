import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAgentRecord } from '@/types'
import AgentRenameHint from './AgentRenameHint.vue'

const { putJson } = vi.hoisted(() => ({ putJson: vi.fn() }))
vi.mock('@/api/client', () => ({ putJson }))

const agent = (nameSuggestion: string | null = 'Iris Vale') => ({
  agentId: 'agent-ppt', personalSpaceId: 'space-a', personalProjectId: 'project-a', nameSuggestion,
  profile: { name: 'PPT 专责', displayName: 'PPT 专责', status: 'active', responsibility: '制作项目汇报 PPT。', capabilities: [], initialPreferences: [] },
  createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
}) as unknown as ProjectAgentRecord

beforeEach(() => { putJson.mockReset() })

describe('AgentRenameHint', () => {
  it('says nothing when the Provider offers no rename', () => {
    expect(mount(AgentRenameHint, { props: { agent: agent(null) } }).find('[data-agent-rename-hint]').exists()).toBe(false)
  })

  it('renames in one click to the suggested name, keeping the job as the role', async () => {
    const saved = { ...agent(null), profile: { ...agent().profile, displayName: 'Iris Vale' } }
    putJson.mockResolvedValue(saved)
    const wrapper = mount(AgentRenameHint, { props: { agent: agent() } })
    expect(wrapper.get('h3').text()).toBe('建议改个名字')
    expect(wrapper.text()).toContain('「PPT 专责」读起来像岗位名称')
    const apply = wrapper.get('[data-agent-rename-apply]')
    expect(apply.text()).toBe('改名为 Iris Vale')
    await apply.trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agents', {
      personalSpaceId: 'space-a', personalProjectId: null, agentId: 'agent-ppt',
      profile: { ...agent().profile, displayName: 'Iris Vale' },
    })
    expect(wrapper.emitted('saved')).toEqual([[saved]])
  })

  it('is not blocking: "keep" hides it without a request, and a failed rename says why', async () => {
    const kept = mount(AgentRenameHint, { props: { agent: agent() } })
    await kept.get('[data-agent-rename-keep]').trigger('click')
    expect(kept.find('[data-agent-rename-hint]').exists()).toBe(false)
    expect(putJson).not.toHaveBeenCalled()
    putJson.mockImplementation(async () => { throw new Error('agent_name_taken') })
    const failed = mount(AgentRenameHint, { props: { agent: agent() } })
    await failed.get('[data-agent-rename-apply]').trigger('click')
    await flushPromises()
    expect(failed.get('[role="alert"]').text()).toBe('改名没有成功：agent_name_taken')
    expect(failed.emitted('saved')).toBeUndefined()
  })
})
