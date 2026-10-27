import { mount, RouterLinkStub } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('@/api/client', () => ({ getJson, postJson: vi.fn(), putJson: vi.fn(), deleteJson: vi.fn() }))

import AgentCard from './AgentCard.vue'
import { useOccupationCatalog } from '@/features/occupations/occupation-catalog'
import { SYNTHETIC_OCCUPATIONS } from '@/test-support/occupation-fixtures'
import { agentAvatarUrl } from './agent-avatar'
import type { ProjectAgentRecord } from '@/types'

// Occupation names come from the space catalog.
beforeAll(async () => {
  getJson.mockResolvedValue(SYNTHETIC_OCCUPATIONS)
  await useOccupationCatalog(ref('space-a')).load()
})

const agent = {
  agentId: 'employee.jefa', personalSpaceId: 'space-a', assignments: [],
  profile: { name: 'Jefa', status: 'active', responsibility: '项目经理', capabilities: [] },
} as unknown as ProjectAgentRecord

const render = (props: Record<string, unknown> = {}) => mount(AgentCard, {
  props: { agent, spaceId: 'space-a', ...props },
  global: { stubs: { RouterLink: RouterLinkStub, AgentHand: true } },
})

describe('AgentCard projects', () => {
  it.each(['jefa', 'bole', 'tonborg'])('uses the %s portrait instead of its occupation icon', (id) => {
    const wrapper = render({ agent: { ...agent, agentId: `employee.${id}`, profile: { ...agent.profile, occupationEmoji: '⚖️' } } })
    expect(wrapper.get('.agent-portrait img').attributes('src')).toContain(`${id}-avatar.webp`)
    expect(wrapper.get('.agent-portrait').text()).toBe('')
  })
  it('keeps the generated portrait stable across profile edits and remounts', async () => {
    const wrapper = render({ agent: { ...agent, agentId: 'custom', profile: { ...agent.profile, occupationEmoji: '🔧' } } })
    const image = () => wrapper.get('.agent-portrait img').attributes('src')
    const original = image()
    expect(original).toBe(agentAvatarUrl('custom'))
    expect(wrapper.get('.agent-portrait').text()).toBe('')
    await wrapper.setProps({ agent: { ...agent, agentId: 'custom', profile: { ...agent.profile, name: 'Renamed', occupationEmoji: '🎨' } } })
    expect(image()).toBe(original)
    wrapper.unmount()
    expect(render({ agent: { ...agent, agentId: 'custom' } }).get('.agent-portrait img').attributes('src')).toBe(original)
  })
  it('uses the Agent identity colour and moves only for a reported running state', () => {
    const entry = (status: string) => ({ status, source: 'roster', taskId: null, title: null, lastUpdateAt: null })
    const running = render({ agent: { ...agent, agentId: 'custom' }, entry: entry('running') }).get('[data-card-portrait]')
    expect(running.attributes('style')).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(running.classes()).toContain('is-working')
    for (const status of ['none', 'blocked', 'unreported']) {
      expect(render({ agent: { ...agent, agentId: 'custom' }, entry: entry(status) }).get('[data-card-portrait]').classes()).not.toContain('is-working')
    }
  })
  it('gives each generated portrait the same identity colour as the profile and pinned nav', () => {
    // Only the identity colours; the working-ring phase follows the wall clock.
    const style = (agentId: string) => (render({ agent: { ...agent, agentId } }).get('[data-card-portrait]').attributes('style') ?? '')
      .split(';').filter(rule => rule.includes('--agent-identity')).join(';')
    expect(style('custom-a')).toMatch(/--agent-identity: var\(--identity-[0-7]\)/)
    expect(style('custom-a')).toBe(style('custom-a'))
    const colours = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map(id => style(`agent-${id}`)))
    expect(colours.size).toBeGreaterThan(1)
    expect(render({ agent: { ...agent, agentId: 'custom-a' } }).get('[data-card-portrait]').classes()).toContain('agent-card-identity')
  })
  it('starts the working ring at the shared clock phase so re-renders never restart it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2400 * 10 + 900)
    expect(render({ agent: { ...agent, agentId: 'custom-a' } }).get('[data-card-portrait]').attributes('style')).toContain('--working-phase: -900ms')
    vi.restoreAllMocks()
  })
  it('shows the person-set occupation next to the name and nothing when unset', () => {
    const classified = render({ agent: { ...agent, occupation: { role: 'product', tags: ['writing'], updatedAt: '2026-10-17T00:00:00Z' } } })
    expect(classified.get('[data-occupation]').text()).toBe('产品 · 写作')
    expect(render().find('[data-occupation]').exists()).toBe(false)
  })
  it('shows the stable FLA employee number', () => {
    expect(render({ agent: { ...agent, employeeNumber: '000001' } }).get('.fla-employee-number').text()).toBe('FLA 000001')
  })
  it('says the Agent manages all projects instead of none when its policy covers every project', () => {
    expect(render({ managesAllProjects: true }).get('.agent-card-projects').text()).toBe('全部项目')
    expect(render().get('.agent-card-projects').text()).toBe('未分配项目')
  })

  it('exposes an accessible pin toggle without navigating the profile', async () => {
    const wrapper = render({ pinned: false })
    const toggle = wrapper.get('[data-agent-pin-toggle]')

    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')

    expect(wrapper.emitted('toggle-pin')).toEqual([[true]])
    expect(wrapper.get('[data-agent-pin-toggle]').attributes('aria-pressed')).toBe('false')
  })

  it('keeps the pin action unavailable while the request is pending', () => {
    const wrapper = render({ pinned: true, pinPending: true })
    const toggle = wrapper.get('[data-agent-pin-toggle]')

    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(wrapper.get('.growth-loading').attributes('aria-label')).toMatch(/Saving pin|正在保存置顶/)
  })

  it('renders name, occupation (including lead/assistant), summary and current task on the card', () => {
    const wrapper = render({
      agent: {
        ...agent,
        agentId: 'agent-lead',
        profile: { ...agent.profile, name: 'Rowan', responsibility: '负责拆活、派活、整合，对用户汇报。' },
        occupation: { role: 'lead', tags: ['engineering'], updatedAt: '2026-10-18T00:00:00Z' },
      },
      entry: {
        status: 'running',
        source: 'tasks',
        taskId: 'task-101',
        title: '收口 R-06 项目视图改造',
        runningSince: '2026-10-18T00:00:00Z',
        lastUpdateAt: '2026-10-18T00:05:00Z',
      },
    })
    expect(wrapper.get('.agent-directory-name').text()).toContain('Rowan')
    expect(wrapper.get('[data-occupation]').text()).toBe('负责人 · 工程')
    expect(wrapper.get('[data-agent-summary]').text()).toBe('负责拆活、派活、整合，对用户汇报。')
    expect(wrapper.get('[data-current-task]').text()).toContain('收口 R-06 项目视图改造')
  })
  it('shows no raw code: occupations and Bole\'s role by name, a blocked or waiting reason by its meaning', () => {
    const bole = render({ agent: { ...agent, agentId: 'employee.bole', employeeNumber: '000002',
      profile: { ...agent.profile, name: 'Bole', agentType: 'hr' }, occupation: { role: 'hr', tags: [], updatedAt: '2026-10-27T00:00:00Z' } } })
    expect(bole.get('.agent-card-role').text()).toBe('Agent 资源')
    // The fixed role is its occupation, so it is not repeated.
    expect(bole.find('[data-occupation]').exists()).toBe(false)
    expect(bole.get('.agent-card-tags').text()).not.toMatch(/\bAR\b|\bhr\b/)

    // assistant is not in this space's synthetic catalog: it reads as the shipped name, never the key.
    const blocked = render({
      agent: { ...agent, agentId: 'agent-fla', employeeNumber: '000025', occupation: { role: 'assistant', tags: ['management'], updatedAt: '2026-10-27T00:00:00Z' } },
      entry: { status: 'blocked', source: 'roster', taskId: 'task-1', title: 'Synthetic task', lastUpdateAt: null, runningSince: null,
        reason: 'project_team_lead: project team lead is the stable conversation owner and fits this work; executor: no usable executor',
        blocker: { reason: 'explicit_agent: explicit Agent selected; executor: no usable executor', since: null, agentId: null,
          application: null, sessionId: null, sessionUrl: null, observed: false } },
    })
    expect(blocked.get('.agent-card-tags').text()).toContain('FLA 000025')
    expect(blocked.get('[data-occupation]').text()).toBe('助手 · 管理')
    const line = blocked.get('[data-blocker-reason]')
    expect(line.text()).toBe('交给你指定的 Agent；没有可用的执行客户端')
    // The one-line card keeps the stored text only as its tooltip.
    expect(line.attributes('title')).toBe('explicit_agent: explicit Agent selected; executor: no usable executor')
    const shown = blocked.text()
    for (const raw of ['explicit_agent', 'no usable executor', 'assistant', 'management']) expect(shown).not.toContain(raw)

    const waiting = render({ agent: { ...agent, agentId: 'agent-fla' },
      entry: { status: 'paused', source: 'roster', taskId: 'task-2', title: 'Synthetic task', lastUpdateAt: null, runningSince: null,
        reason: 'recruitment cancelled: synthetic reason' } })
    expect(waiting.get('[data-status-detail]').text()).toBe('已暂停：招聘已取消，任务在等待重新安排')
  })
  it('offers the #FLA copy only on an FLA, never on a FULI role', () => {
    expect(render().find('[data-agent-mention-copy]').exists()).toBe(false)
    const fla = render({ agent: { ...agent, agentId: 'custom', profile: { ...agent.profile, name: 'PPT 专责', displayName: 'Iris Vale' } } })
    expect(fla.get('[data-agent-mention-copy]').attributes('aria-label')).toBe('复制 #FLA Iris Vale')
  })
})
