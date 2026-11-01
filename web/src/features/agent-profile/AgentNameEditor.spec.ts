import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import type { ProjectAgentRecord } from '@/types'
// Reads and writes pass their response shape (api/response-shape.ts) last.
const SHAPE = expect.objectContaining({ schema: expect.anything() })

const { putJson } = vi.hoisted(() => ({ putJson: vi.fn() }))
vi.mock('@/api/client', async (original) => ({ ...(await original<typeof import('@/api/client')>()), putJson }))

const { default: AgentNameEditor } = await import('./AgentNameEditor.vue')

const agent = (agentId = 'agent-synthetic', name = 'Iris Vale', displayName: string | null = null) => ({
  agentId, personalSpaceId: 'space-a', personalProjectId: null,
  profile: { name, displayName, status: 'active', responsibility: '', capabilities: [], initialPreferences: [] },
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
}) as unknown as ProjectAgentRecord

const taken = new ApiError('409', 409, JSON.stringify({
  error: 'agent_name_taken: another Agent in this personal space already uses this name; free names: Nora Lin, Theo Hart. Choose one or propose another.',
  code: 'provider_error',
}))

beforeEach(() => putJson.mockReset())

async function edit(wrapper: ReturnType<typeof mount>, value: string) {
  await wrapper.get('[data-agent-name-edit]').trigger('click')
  const input = wrapper.get('[data-agent-name-input]')
  await input.setValue(value)
  return input
}

describe('AgentNameEditor', () => {
  it('renames in place: the pencil opens one line, Enter saves only the name', async () => {
    const renamed = agent('agent-synthetic', 'Iris Vale', 'Mira Stone')
    putJson.mockResolvedValue(renamed)
    const wrapper = mount(AgentNameEditor, { props: { agent: agent() } })
    expect(wrapper.get('h1').text()).toBe('Iris Vale')
    const input = await edit(wrapper, '  Mira   Stone ')
    expect(input.attributes('maxlength')).toBe('64')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agents/agent-synthetic/name', { personalSpaceId: 'space-a', displayName: 'Mira Stone' }, SHAPE)
    expect(wrapper.emitted('saved')).toEqual([[renamed]])
    expect(wrapper.find('[data-agent-name-input]').exists()).toBe(false)
  })

  it('Esc puts the name back, and an unchanged name sends nothing', async () => {
    const wrapper = mount(AgentNameEditor, { props: { agent: agent() } })
    const input = await edit(wrapper, 'Someone Else')
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.get('h1').text()).toBe('Iris Vale')
    await edit(wrapper, 'Iris Vale')
    await wrapper.get('form').trigger('submit')
    expect(putJson).not.toHaveBeenCalled()
  })

  it('offers the free names when another Agent uses the name, each one click away', async () => {
    putJson.mockRejectedValueOnce(taken).mockResolvedValueOnce(agent('agent-synthetic', 'Iris Vale', 'Theo Hart'))
    const wrapper = mount(AgentNameEditor, { props: { agent: agent() } })
    await edit(wrapper, 'Nova Reed')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toBe('「Nova Reed」已经有别的 FLA 在用了')
    const free = wrapper.findAll('[data-agent-name-free] button')
    expect(free.map(button => button.text())).toEqual(['Nora Lin', 'Theo Hart'])
    await free[1]!.trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenLastCalledWith('/api/project-agents/agent-synthetic/name', { personalSpaceId: 'space-a', displayName: 'Theo Hart' }, SHAPE)
    expect(wrapper.find('[data-agent-name-free]').exists()).toBe(false)
  })

  it('gives a renamed built-in role its own name back; other Agents have no such button', async () => {
    putJson.mockResolvedValue(agent('employee.bole', 'Bole', null))
    const role = mount(AgentNameEditor, { props: { agent: agent('employee.bole', 'Bole', '伯乐') } })
    expect(role.get('h1').text()).toBe('伯乐')
    await role.get('[data-agent-name-restore]').trigger('click')
    await flushPromises()
    expect(putJson).toHaveBeenCalledWith('/api/project-agents/employee.bole/name', { personalSpaceId: 'space-a', displayName: null }, SHAPE)
    expect(mount(AgentNameEditor, { props: { agent: agent('employee.bole', 'Bole', null) } }).find('[data-agent-name-restore]').exists()).toBe(false)
    expect(mount(AgentNameEditor, { props: { agent: agent('agent-synthetic', 'Iris Vale', 'Mira') } }).find('[data-agent-name-restore]').exists()).toBe(false)
  })
})
