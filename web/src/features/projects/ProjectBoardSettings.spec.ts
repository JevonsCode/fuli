import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const putJson = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/client')>()), getJson, postJson, putJson }))

import { ApiError } from '@/api/client'
import { RadioGroup } from '@/components/ui/radio-group'
import { setLocale } from '@/i18n'
import ProjectBoardSettings from './ProjectBoardSettings.vue'
import type { ProjectTeam, ProjectTeamPerson } from './project-team-api'

// Synthetic project and Agents only.
const person = (agentId: string, extra: Partial<ProjectTeamPerson> = {}): ProjectTeamPerson => ({
  agentId, name: agentId, employeeNumber: null, occupationEmoji: null, responsibility: '', peerRole: false, ...extra,
})
const team: ProjectTeam = {
  personalProjectId: 'project-a', status: 'ready', lead: person('Lead'), unavailableLead: null,
  members: [person('活动经理')], collaborators: [], peers: [person('employee.jefa', { peerRole: true })], unavailableMemberIds: [],
}
const untouched = { projectId: 'project-a', revision: 0, managerAgentId: null, board: { kind: 'builtin', columns: [] }, updatedAt: null }

function answer(projectBoard: unknown = untouched) {
  postJson.mockImplementation(async (url: string, body: { tool?: string; arguments?: Record<string, unknown> }) => {
    if (url === '/api/employee-templates/jefa/call' && body.tool === 'read_board') return { items: [], projectBoard }
    if (url === '/api/employee-templates/jefa/call' && body.tool === 'configure_project_board') {
      return { projectBoard: { ...untouched, revision: 1, managerAgentId: body.arguments!.managerAgentId, board: body.arguments!.board } }
    }
    if (url === '/api/project-agent-assignments') return { status: 'active', projectBoard: { ...untouched, revision: 1 } }
    throw new Error(`unexpected ${url}`)
  })
}

async function setup() {
  const wrapper = mount(ProjectBoardSettings, {
    attachTo: document.body,
    props: { spaceId: 'space-a', projectId: 'project-a', projectName: '活动' },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
  await flushPromises()
  return wrapper
}
const configureCall = () => postJson.mock.calls.find(([, body]) => body.tool === 'configure_project_board')?.[1].arguments

beforeEach(() => {
  setLocale('zh-CN')
  getJson.mockReset().mockResolvedValue(team)
  postJson.mockReset()
  putJson.mockReset().mockResolvedValue({})
  answer()
})

describe('project board settings', () => {
  it('offers the project\'s own Agents as its manager and saves the person\'s columns in order', async () => {
    const wrapper = await setup()
    expect(wrapper.getComponent(RouterLinkStub).props('to')).toEqual({ path: '/employees/jefa', query: { project: 'project-a' } })
    const manager = wrapper.findAllComponents({ name: 'OptionCombobox' })[0]!
    expect(manager.props('options').map(({ label }: { label: string }) => label)).toEqual(['由 Jefa 直接管理', 'Lead', '活动经理'])

    await wrapper.get('[data-action="start-defaults"]').trigger('click')
    const labels = wrapper.findAll('[data-column-label]')
    expect(labels).toHaveLength(5)
    await labels[0]!.setValue('待开发')
    await wrapper.findAll('[data-column-row]')[0]!.findAll('button').find((button) => button.attributes('aria-label') === '下移「待开发」')!.trigger('click')
    manager.vm.$emit('update:modelValue', '活动经理')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const saved = configureCall()
    expect(saved).toMatchObject({ expectedRevision: 0, managerAgentId: '活动经理', board: { kind: 'builtin' } })
    expect(saved.requestId).toMatch(/^project-page-board-/)
    expect(saved.board.columns.map(({ label, mapsTo }: { label: string; mapsTo: string }) => [label, mapsTo]))
      .toEqual([['进行中', 'active'], ['待开发', 'planned'], ['阻塞', 'blocked'], ['待确认', 'review'], ['已完成', 'done']])
    expect(wrapper.text()).toContain('项目看板已保存。')
  })

  it('checks an external link before saving it', async () => {
    const wrapper = await setup()
    wrapper.getComponent(RadioGroup).vm.$emit('update:modelValue', 'external')
    await flushPromises()
    await wrapper.get('[data-external-url]').setValue('javascript:alert(1)')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.text()).toContain('请填写以 http:// 或 https:// 开头的链接。')
    expect(configureCall()).toBeUndefined()

    await wrapper.get('[data-external-url]').setValue('https://project.example.test/board')
    await wrapper.get('[data-external-label]').setValue('飞书项目')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(configureCall().board).toEqual({ kind: 'external', external: { url: 'https://project.example.test/board', label: '飞书项目' } })
  })

  it('recruits a new manager with the 管理 occupation and makes it the manager in its assignment', async () => {
    const wrapper = await setup()
    await wrapper.get('[data-action="open-recruit"]').trigger('click')
    expect((wrapper.get('[data-recruit-name]').element as HTMLInputElement).value).toBe('活动项目经理')
    await wrapper.get('[data-action="recruit"]').trigger('click')
    await flushPromises()

    const [url, agent] = putJson.mock.calls[0]!
    expect(url).toBe('/api/project-agents')
    expect(agent).toMatchObject({ personalSpaceId: 'space-a', personalProjectId: null, occupation: { role: 'management', tags: [] },
      profile: { name: '活动项目经理', status: 'active' } })
    const assignment = postJson.mock.calls.find(([target]) => target === '/api/project-agent-assignments')![1]
    expect(assignment).toMatchObject({ personalProjectId: 'project-a', agentId: agent.agentId, projectManager: { board: { kind: 'builtin', columns: [] } } })
    expect(assignment.idempotencyKey).toBe(`project-board:${agent.agentId}`)
    expect(wrapper.text()).toContain('项目看板已保存。')
  })

  it('names a saved manager who left the project, and says so when Jefa does not manage the project', async () => {
    answer({ ...untouched, revision: 2, managerAgentId: 'former-pm' })
    const wrapper = await setup()
    expect(wrapper.get('[data-manager-gone]').text()).toContain('former-pm')
    wrapper.unmount()

    postJson.mockRejectedValue(new ApiError('refused', 403, JSON.stringify({ code: 'assignment_required' })))
    const refused = await setup()
    expect(refused.find('[data-project-board-not-managed]').exists()).toBe(true)
    refused.unmount()
  })
})
