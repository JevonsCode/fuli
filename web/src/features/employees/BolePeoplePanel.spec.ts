import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { defineComponent, h, ref } from 'vue'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson }))

import BolePeoplePanel from './BolePeoplePanel.vue'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { provideWorkbenchToolbarActions } from './workbench-toolbar'

const projects = [
  { project_id: 'project-a', personal_space_id: 'space-a', profile: { name: '复利' } },
  { project_id: 'project-b', personal_space_id: 'space-a', profile: { name: '第二项目' } },
]

let router: Router
function mountPanel() {
  return mount(BolePeoplePanel, { props: { personalSpaceId: 'space-a', projects }, global: { plugins: [router] } })
}

beforeEach(async () => {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/employees')
  await router.isReady()
  setActivePinia(createPinia())
  getJson.mockReset()
  getJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/project-agents?')) return { agents: [
      {
        agent_id: 'employee.bole', personal_space_id: 'space-a',
        profile: { name: 'Bole', responsibility: '招募与人员配置', status: 'active', agent_type: 'hr', occupation_emoji: '🔎' },
        created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z',
      },
      {
        agent_id: 'employee.jefa', personal_space_id: 'space-a',
        profile: { name: 'Jefa', responsibility: '项目管理', capabilities: ['planning'], workKinds: ['implementation'], status: 'active', agent_type: 'durable', occupation_emoji: '🧭' },
        assignments: [{ personal_project_id: 'project-a', status: 'active' }],
        created_at: '2026-09-01T08:00:00.000Z', updated_at: '2026-09-01T08:00:00.000Z',
      },
      {
        agent_id: 'agent.researcher', personal_space_id: 'space-a',
        profile: { name: 'Researcher', responsibility: '调研', capabilities: ['usability research'], work_kinds: ['interviews'], status: 'active', agent_type: 'temporary', occupation_emoji: '🧪' },
        personal_project_id: 'project-b',
        created_at: '2026-09-02T08:00:00.000Z', updated_at: '2026-09-02T08:00:00.000Z',
      },
    ] }
    if (url.startsWith('/api/project-agent-tasks?')) return { items: [
      {
        task_id: 'task-a', personal_project_id: 'project-a', title: '整理发布检查项', status: 'running',
        lead_agent_id: 'employee.jefa', coordinator_agent_id: 'system.coordinator', hr_agent_id: 'employee.bole', participants: [], created_at: '2026-09-03T08:00:00.000Z',
      },
    ] }
    if (url.startsWith('/api/project-agent-recruitments?')) return { recruitments: [
      {
        recruitment_id: 'recruit-a', personal_space_id: 'space-a', personal_project_id: 'project-b', task_id: 'task-b',
        coordinator_agent_id: 'system.coordinator', hr_agent_id: 'employee.bole', position_kind: 'temporary', work_kind: 'research',
        required_capabilities: ['research'], reason_code: 'capability_gap', reason: '需要补充用户研究能力', status: 'fulfilled',
        proposed_agent_id: 'agent.researcher', recruited_agent_id: 'agent.researcher', created_at: '2026-09-02T08:00:00.000Z',
        updated_at: '2026-09-02T09:00:00.000Z', fulfilled_at: '2026-09-02T09:00:00.000Z',
      },
    ] }
    throw new Error(`unexpected URL: ${url}`)
  })
})

describe('Bole people panel', () => {
  it('opens a distinct profile for each name in people and recruitment history', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const links = wrapper.findAll('.bole-agent-identity a')
    expect(wrapper.findAll('.bole-agent-mark img').map(image => image.attributes('src'))).toEqual(
      ['employee.jefa', 'employee.bole', 'agent.researcher'].map(agentAvatarUrl),
    )
    expect(links.map(link => link.attributes('href'))).toEqual([
      '/agents/space-a/employee.jefa', '/agents/space-a/employee.bole', '/agents/space-a/agent.researcher',
    ])
    await links[0]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/employee.jefa')
    await links[1]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/employee.bole')
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    const recruited = wrapper.get('.bole-recruitment-identity a')
    expect(recruited.text()).toBe('Researcher')
    await recruited.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/agents/space-a/agent.researcher')
    wrapper.unmount()
  })

  it('matches multiword capability, work kind and project searches with English typos', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('.bole-search').setValue('第二项目 usabilty intervews')
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(1)
    expect(wrapper.get('.bole-agent-card').text()).toContain('Researcher')
    await wrapper.get('.bole-search').setValue('Jefa implementaton 项目管理')
    expect(wrapper.get('.bole-agent-card').text()).toContain('Jefa')
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    await wrapper.get('.bole-search').setValue('调研 usabilty 第二项目')
    expect(wrapper.findAll('.bole-timeline li')).toHaveLength(1)
    wrapper.unmount()
  })

  it('prefills from q and clears the previous query when switching spaces', async () => {
    await router.push('/employees?q=usabilty')
    const wrapper = mountPanel()
    await flushPromises()
    expect((wrapper.get('.bole-search').element as HTMLInputElement).value).toBe('usabilty')
    expect(wrapper.get('.bole-agent-card').text()).toContain('Researcher')
    await router.push('/employees?q=planning')
    await flushPromises()
    expect(wrapper.get('.bole-agent-card').text()).toContain('Jefa')
    await wrapper.setProps({ personalSpaceId: 'space-b' })
    await flushPromises()
    expect((wrapper.get('.bole-search').element as HTMLInputElement).value).toBe('')
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(3)
    wrapper.unmount()
  })

  it('makes its two views the section tabs, with no title, frame or duplicate totals of its own', async () => {
    const wrapper = mountPanel()
    expect(wrapper.get('[data-testid="people-total"]').text()).toBe('—')
    await flushPromises()
    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.find('.ui-card').exists()).toBe(false)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map(tab => tab.text())).toEqual(['团队成员 3', '工作记录 1'])
    expect(tabs[0]!.attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll('[data-testid="people-total"]')).toHaveLength(1)
    expect(wrapper.get('.bole-summary').text()).not.toContain('在岗')
    expect(wrapper.get('[role="tabpanel"][data-state="active"]').attributes('aria-labelledby')).toBe(tabs[0]!.attributes('id'))
    await wrapper.get('.bole-search').setValue('Jefa')
    expect(wrapper.get('.bole-result-count').text()).toContain('1')
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    expect(wrapper.get('[role="tabpanel"][data-state="active"]').attributes('aria-labelledby')).toBe(wrapper.get('[data-bole-view="history"]').attributes('id'))
    wrapper.unmount()
  })

  it('shows people and records as cards, not a table', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.find('table, [role="table"], .bole-table-heading').exists()).toBe(false)
    expect(wrapper.findAll('.bole-agent-list > li.bole-agent-card')).toHaveLength(3)
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    expect(wrapper.findAll('.bole-timeline > li.bole-recruitment-card')).toHaveLength(1)
    wrapper.unmount()
  })

  it('puts refresh in the workbench toolbar when the workbench provides one', async () => {
    const target = document.createElement('div')
    document.body.append(target)
    const Host = defineComponent({ setup() {
      provideWorkbenchToolbarActions(ref(target))
      return () => h(BolePeoplePanel, { personalSpaceId: 'space-a', projects })
    } })
    const wrapper = mount(Host, { global: { plugins: [router] } })
    await flushPromises()
    expect(wrapper.find('.bole-refresh').exists()).toBe(false)
    const refresh = target.querySelector<HTMLButtonElement>('.bole-refresh')!
    expect(refresh.textContent).toContain('刷新')
    refresh.click()
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(6)
    wrapper.unmount()
    target.remove()
  })

  it('says a view could not be read instead of calling it empty, and retries', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agents?')) throw new Error('暂时不可用')
      return original(url)
    })
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.get('[data-bole-load-error]').text()).toContain('团队成员读取失败')
    expect(wrapper.text()).not.toContain('还没有可展示的 Agent')
    expect(wrapper.find('.bole-alert').exists()).toBe(false)
    expect(wrapper.get('[data-testid="people-total"]').text()).toBe('—')
    expect(wrapper.get('[data-testid="people-working"] dd').text()).toBe('—')
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    expect(wrapper.find('[data-bole-load-error]').exists()).toBe(false)
    expect(wrapper.get('.bole-alert').text()).toContain('部分人员信息暂时不可用')
    await wrapper.get('[data-bole-view="people"]').trigger('mousedown')
    getJson.mockImplementation(original)
    await wrapper.get('[data-bole-load-error] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-bole-load-error]').exists()).toBe(false)
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(3)
    wrapper.unmount()
  })

  it('shows personnel distribution, current work and recruitment reasons from the shared Agent APIs', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    expect(getJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/project-agents?personalSpaceId=space-a',
      '/api/project-agent-tasks?personalSpaceId=space-a&limit=200',
      '/api/project-agent-recruitments?personalSpaceId=space-a',
    ])
    expect(wrapper.get('[data-testid="people-total"]').text()).toContain('3')
    expect(wrapper.get('[data-testid="people-working"]').text()).toContain('1')
    expect(wrapper.text()).toContain('固定 Agent')
    expect(wrapper.text()).toContain('临时 Agent')
    expect(wrapper.text()).toContain('Jefa')
    expect(wrapper.text()).toContain('整理发布检查项')
    const status = wrapper.get('.bole-status')
    expect(status.text()).toBe('运行中')
    expect(status.attributes('title')).toBeUndefined()
    expect(wrapper.text()).toContain('复利')
    expect(wrapper.text()).toContain('Researcher')
    expect(wrapper.text()).toContain('第二项目')
    expect(wrapper.find('.bole-timeline').exists()).toBe(false)
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    expect(wrapper.text()).toContain('需要补充用户研究能力')
    expect(wrapper.find('.bole-agent-list').exists()).toBe(false)
  })

  it('filters people by project, work status, role and search without changing records', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(3)
    expect(wrapper.findAll('.bole-agent-card')[0].text()).toContain('Jefa')
    wrapper.getComponent(ProjectScopePicker).vm.$emit('update:modelValue', ['project-b'])
    await flushPromises()
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(1)
    expect(wrapper.get('.bole-agent-card').text()).toContain('Researcher')
    await wrapper.get('.bole-filters .ui-segmented button:nth-child(2)').trigger('click')
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(0)
    await wrapper.get('.bole-clear').trigger('click')
    await wrapper.get('.bole-search').setValue('发布')
    expect(wrapper.get('.bole-agent-card').text()).toContain('Jefa')
    await wrapper.get('.bole-clear').trigger('click')
    const roleButton = wrapper.findAll('.bole-role-filters button').find((button) => button.text().includes('AR Agent'))!
    await roleButton.trigger('click')
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(1)
    expect(wrapper.get('.bole-agent-card').text()).toContain('Bole')
    expect(getJson).toHaveBeenCalledTimes(3)
  })

  it('supports no selected projects, unassigned Agents and clearing filters', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const picker = wrapper.getComponent(ProjectScopePicker)
    picker.vm.$emit('update:modelValue', [])
    await flushPromises()
    expect(wrapper.text()).toContain('没有匹配的记录')
    const unassigned = picker.props('projects').find((item) => item.name === '未归属项目')!
    picker.vm.$emit('update:modelValue', [unassigned.id])
    await flushPromises()
    expect(wrapper.get('.bole-agent-card').text()).toContain('Bole')
    await wrapper.get('.bole-clear').trigger('click')
    expect(wrapper.findAll('.bole-agent-card')).toHaveLength(3)
  })

  it('searches recruitment reasons and shares the same project scope across views', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-bole-view="history"]').trigger('mousedown')
    await wrapper.get('.bole-search').setValue('用户研究')
    expect(wrapper.findAll('.bole-timeline li')).toHaveLength(1)
    expect(wrapper.get('time').attributes('datetime')).toBe('2026-09-02T08:00:00.000Z')
    wrapper.getComponent(ProjectScopePicker).vm.$emit('update:modelValue', ['project-a'])
    await flushPromises()
    expect(wrapper.text()).toContain('没有匹配的记录')
    await wrapper.get('.bole-clear').trigger('click')
    expect(wrapper.findAll('.bole-timeline li')).toHaveLength(1)
  })

  it('preserves Provider work state instead of attributing AR/coordinator tasks to them', async () => {
    const original = getJson.getMockImplementation()!
    getJson.mockImplementation(async (url: string) => {
      const result = await original(url)
      if (url.startsWith('/api/project-agents?')) result.agents[1] = { ...result.agents[1], work_status: 'completed', current_task_id: 'task-a' }
      return result
    })
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.get('[data-testid="people-working"]').text()).toContain('0')
    expect(wrapper.findAll('.bole-status')).toHaveLength(0)
  })

  it('keeps partial data visible and offers a retry when one source fails', async () => {
    getJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/project-agents?')) return { agents: [] }
      throw new Error('暂时不可用')
    })
    const wrapper = mountPanel()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('部分人员信息暂时不可用')
    expect(wrapper.text()).toContain('还没有可展示的 Agent')
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()
    expect(getJson).toHaveBeenCalledTimes(6)
  })
})
