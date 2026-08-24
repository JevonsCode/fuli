import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getJson = vi.hoisted(() => vi.fn())
const patchJson = vi.hoisted(() => vi.fn())
const postJson = vi.hoisted(() => vi.fn())
const deleteJson = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ getJson, patchJson, postJson, deleteJson }))

import { useConsoleStore } from '@/stores/console'
import { SearchableSelectStub } from '@/test-support/SearchableSelectStub'
import type { ProjectAgentRecord } from '@/types'
import ProjectAgentsPage from './ProjectAgentsPage.vue'

const agents: ProjectAgentRecord[] = [
  {
    agentId: 'shared-agent',
    personalSpaceId: 'personal-1',
    personalProjectId: 'project-a',
    profile: {
      name: '活动 Agent',
      responsibility: '负责活动方案与复盘。',
      capabilities: ['活动策划', '活动复盘'],
      initialPreferences: ['先给结论'],
      status: 'active',
      agentType: 'durable',
      defaultModelStrategy: {
        mode: 'adaptive',
        capabilityHints: ['活动复盘'],
      },
      executorPolicy: { mode: 'flexible', allowList: [] },
    },
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T01:00:00Z',
    assignments: [{
      assignmentId: 'assignment-a',
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-a',
      agentId: 'shared-agent',
      responsibility: '负责活动方案与复盘。',
      scope: '活动项目',
      status: 'active',
      assignedAt: '2026-08-17T00:00:00Z',
      updatedAt: '2026-08-17T01:00:00Z',
    }],
  },
  {
    agentId: 'shared-agent',
    personalSpaceId: 'personal-1',
    personalProjectId: 'project-b',
    profile: {
      name: '设计 Agent',
      responsibility: '负责界面结构与可用性审查。',
      capabilities: ['界面设计'],
      initialPreferences: [],
      status: 'inactive',
    },
    createdAt: '2026-08-17T00:00:00Z',
    updatedAt: '2026-08-17T02:00:00Z',
    assignments: [{
      assignmentId: 'assignment-b',
      personalSpaceId: 'personal-1',
      personalProjectId: 'project-b',
      agentId: 'shared-agent',
      responsibility: '负责界面结构与可用性审查。',
      scope: '设计项目',
      status: 'active',
      assignedAt: '2026-08-17T00:00:00Z',
      updatedAt: '2026-08-17T02:00:00Z',
    }],
  },
]

describe('ProjectAgentsPage', () => {
  beforeEach(() => {
    getJson.mockReset()
    patchJson.mockReset()
    postJson.mockReset()
    deleteJson.mockReset()
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: agents.flatMap((agent) => agent.assignments ?? []) })
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
  })

  it('renders one space Agent row with cross-project assignments', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(getJson).toHaveBeenCalledWith(
      '/api/project-agents?personalSpaceId=personal-1',
    )
    expect(wrapper.findAll('.project-agent-row')).toHaveLength(1)
    expect(wrapper.get('.project-agent-detail').text()).toContain('负责活动方案与复盘。')
    expect(wrapper.get('.project-agent-detail').text()).toContain('负责界面结构与可用性审查。')
    expect(wrapper.get('.project-agent-detail').text()).toContain('活动项目')
    expect(wrapper.get('.project-agent-detail').text()).toContain('设计项目')
    expect(getJson.mock.calls.some(([url]) => String(url).includes('project-agent-context')))
      .toBe(false)
  })

  it('filters by project, status, and responsibility search', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    await wrapper.get('[aria-label="项目范围"]').setValue('project-b')
    expect(wrapper.findAll('.project-agent-row')).toHaveLength(1)
    expect(wrapper.get('.project-agent-row').text()).toContain('活动 Agent')
    expect(wrapper.get('.project-agent-automation-policy').text()).toContain('设计项目')

    await wrapper.get('[aria-label="项目范围"]').setValue('all')
    expect(wrapper.find('.project-agent-automation-policy').exists()).toBe(false)
    await wrapper.get('.project-agents-status-filter button:nth-child(2)').trigger('click')
    expect(wrapper.findAll('.project-agent-row')).toHaveLength(1)
    expect(wrapper.get('.project-agent-row').text()).toContain('活动 Agent')

    await wrapper.get('.project-agents-status-filter button:first-child').trigger('click')
    await wrapper.get('input[type="search"]').setValue('可用性')
    expect(wrapper.findAll('.project-agent-row')).toHaveLength(1)
    expect(wrapper.get('.project-agent-row').text()).toContain('活动 Agent')
  })

  it('shows request errors and retries the roster load', async () => {
    getJson.mockRejectedValueOnce(new Error('provider unavailable'))
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('provider unavailable')
    getJson.mockResolvedValueOnce(agents)
    await wrapper.get('[role="alert"] button').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findAll('.project-agent-row')).toHaveLength(1)
  })

  it('shows only reported execution data and loads task/activity evidence on demand', async () => {
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.get('.project-agent-row-work').text()).toContain('无运行记录')
    expect(wrapper.get('.project-agent-detail').text()).toContain('flexible')
    expect(wrapper.get('.project-agent-detail').text()).toContain('没有真实学习依据')

    getJson.mockImplementation((url: string) => {
      if (url.includes('/project-agent-tasks?')) {
        return Promise.resolve({ tasks: [{
          task_id: 'task-1',
          title: '活动复盘',
          personal_project_id: 'project-a',
          status: 'completed',
          run_id: 'run-1',
          participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'completed' }],
          events: [{
            event_id: 'event-1', task_id: 'task-1', agent_id: 'shared-agent', status: 'completed',
            summary: '已完成', source_application: 'codex', actual_model_provider: 'openai', actual_model: 'model-x',
            created_at: '2026-08-17T03:00:00Z',
          }],
        }] })
      }
      if (url.includes('/project-agent-activity?')) {
        return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [{
          date: '2026-08-17', completed: 1, failed: 0, cancelled: 0, total: 1,
          tasks: [{ task_id: 'task-1', title: '活动复盘', status: 'completed', summary: '已完成', occurred_at: '2026-08-17T03:00:00Z', personal_project_id: 'project-a' }],
        }] })
      }
      if (url.includes('/executors?')) return Promise.resolve({ executors: [{ executor_id: 'executor-1', provider: 'openai', model: 'model-x', client: 'codex', allowed: true, actual_use: { count: 1, last_used_at: '2026-08-17T03:00:00Z' } }] })
      if (url.includes('/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      return Promise.resolve({ learning_evidence: {} })
    })
    await wrapper.get('.project-agent-detail-actions .quiet-button').trigger('click')
    await flushPromises()

    expect(wrapper.get('.project-agent-task-card').text()).toContain('openai')
    expect(wrapper.get('.project-agent-task-card').text()).toContain('model-x')
    expect(wrapper.get('.project-agent-task-card').text()).toContain('Codex')
    expect(wrapper.find('.project-agent-heatmap').exists()).toBe(true)
    await wrapper.get('.project-agent-heat-cell').trigger('click')
    expect(wrapper.get('.project-agent-day-detail').text()).toContain('活动复盘')
    expect(wrapper.get('.project-agent-client-list').text()).toContain('实际调用 1 次')
  })

  it('shows an initial real run from the space task list without opening details', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{
        task_id: 'task-running',
        title: '正在整理活动复盘',
        personal_project_id: 'project-a',
        status: 'running',
        run_id: 'run-running',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }],
      }] })
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.get('.project-agent-row-work').text()).toContain('正在整理活动复盘')
    expect(wrapper.get('.project-agent-row-work').text()).toContain('运行中')
  })

  it('prioritizes occupation emoji in the personnel directory', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) {
        return Promise.resolve([{ ...agents[0], profile: { ...agents[0].profile, occupationEmoji: '🎛️' } }])
      }
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    const row = wrapper.get('.project-agent-row')
    expect(row.get('[role="img"]').text()).toBe('🎛️')
    expect(row.text()).toContain('活动 Agent')
    expect(row.text()).toContain('长期')
    expect(row.text()).toContain('负责活动方案与复盘。')
    expect(row.text()).toContain('可用')
  })

  it('renders real per-worker execution summaries with worker fallback fields', async () => {
    const task = {
      task_id: 'task-summary',
      title: '整理执行结果',
      personal_project_id: 'project-a',
      status: 'running',
      participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'running' }],
      execution_summary: [
        {
          worker_id: 'worker-1', worker_label: '真实子 Agent', worker_occupation_emoji: '🧭',
          agent_id: 'shared-agent', participant_role: 'collaborator', executor: '本地执行器', executor_id: 'executor-1',
          source_application: 'codex', actual_model_provider: 'openai', actual_model: 'model-x',
          work_summary: '完成结构审查', status: 'completed',
        },
        {
          agent_id: 'shared-agent', agent_name: '活动 Agent', occupation_emoji: '🎛️',
          participant_role: 'lead', work_summary: '等待收尾', status: 'failed',
        },
      ],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    const summary = wrapper.get('.project-agent-execution-summary')
    expect(summary.text()).toContain('真实子 Agent')
    expect(summary.text()).toContain('🧭')
    expect(summary.text()).toContain('executor-1')
    expect(summary.text()).toContain('Codex')
    expect(summary.text()).toContain('model-x')
    expect(summary.text()).toContain('完成结构审查')
    expect(summary.text()).toContain('已完成')
    expect(summary.text()).toContain('失败')
    expect(summary.get('.project-agent-execution-summary-list').element.tagName).toBe('UL')
    expect(summary.findAll('.project-agent-execution-summary-row')).toHaveLength(2)
    expect(summary.findAll('.project-agent-execution-summary-row').every((row) => row.element.tagName === 'LI')).toBe(true)
    expect(summary.findAll('.project-agent-execution-summary-row')[1].text()).not.toContain('实际模型')
  })

  it('shows a reported empty execution summary without treating an unreported field as empty', async () => {
    const task = {
      task_id: 'task-empty-summary', title: '等待执行者', personal_project_id: 'project-a', status: 'running', participants: [], execution_summary: [],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.get('.project-agent-execution-summary').text()).toContain('没有真实参与执行者')

    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{ ...task, execution_summary: undefined }] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    await wrapper.get('.project-agent-detail-actions .quiet-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.project-agent-execution-summary').exists()).toBe(false)
  })

  it('shows worker event evidence separately when execution summary is absent', async () => {
    const task = {
      task_id: 'task-worker-event', title: '验证工作进程', personal_project_id: 'project-a', status: 'completed', participants: [],
      events: [{
        event_id: 'event-worker', task_id: 'task-worker-event', status: 'completed',
        summary: '完成独立验证', worker_id: 'worker-event-1', worker_label: '验证工作进程',
        worker_occupation_emoji: '🔌', worker_status: 'completed', source_application: 'codex',
        actual_model_provider: 'openai', actual_model: 'model-event', created_at: '2026-08-17T04:00:00Z',
      }],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    const evidence = wrapper.get('.project-agent-worker-event-evidence')
    expect(evidence.text()).toContain('验证工作进程')
    expect(evidence.text()).toContain('worker-event-1')
    expect(evidence.text()).toContain('完成独立验证')
    expect(evidence.text()).toContain('model-event')
    expect(wrapper.find('.project-agent-execution-summary').exists()).toBe(false)
  })

  it('renders the reported staffing decision without treating configured Agents as workers', async () => {
    const task = {
      task_id: 'task-routing-decision', title: '拆分验证任务', personal_project_id: 'project-a', status: 'running', participants: [],
      routing_decision: {
        decision_id: 'decision-1', coordinator_agent_id: 'coordinator-1', complexity: 'high',
        complexity_basis: ['多个独立工作流'], outcome: 'parallel_reuse', reason: '已有能力覆盖',
        match_basis: ['capability', 'assignment'], candidate_agent_ids: ['worker-a', 'worker-b'],
        parallel_plan: {
          enabled: true, independent_verification: true, conflict_free_scopes: true,
          reason: '工作范围互斥', workstream_boundaries: ['结构审查', '行为验证'],
        },
      },
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [task] })
      if (url.includes('/api/project-agent-activity?')) return Promise.resolve({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    const decision = wrapper.get('.project-agent-routing-decision')
    expect(decision.text()).toContain('已报告排班决定')
    expect(decision.text()).toContain('coordinator-1')
    expect(decision.text()).toContain('high')
    expect(decision.text()).toContain('worker-a')
    expect(decision.text()).toContain('工作范围互斥')
    expect(decision.text()).toContain('结构审查')
    expect(wrapper.find('.project-agent-execution-summary').exists()).toBe(false)
  })

  it('keeps blocked work visible in the main personnel list', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [{
        task_id: 'task-blocked',
        title: '等待已锁定执行器',
        personal_project_id: 'project-a',
        status: 'blocked',
        participants: [{ agent_id: 'shared-agent', role: 'lead', status: 'blocked' }],
      }] })
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(wrapper.get('.project-agent-row-work').text()).toContain('等待已锁定执行器')
  })

  it('keeps the public year heatmap scroller inside its layout boundary', async () => {
    const activityUrls: string[] = []
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-activity?')) {
        activityUrls.push(url)
        return Promise.resolve({
          agent_id: 'shared-agent', personal_space_id: 'personal-1',
          from_date: '2026-08-15', to_date: '2026-08-17',
          days: [{ date: '2026-08-15', completed: 1, failed: 0, cancelled: 0, total: 1, tasks: [] }],
        })
      }
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()

    expect(activityUrls).toHaveLength(1)
    expect(activityUrls[0]).toMatch(/fromDate=\d{4}-\d{2}-\d{2}/)
    expect(activityUrls[0]).toMatch(/toDate=\d{4}-\d{2}-\d{2}/)
    const heatmapViewport = wrapper.get('.project-agent-heatmap-viewport')
    const heatmap = heatmapViewport.get('.project-agent-heatmap')
    const cells = wrapper.findAll('.project-agent-heat-cell')

    expect(cells).toHaveLength(3)
    expect(cells[0].attributes('aria-label')).toContain('8月17日')
    expect(cells[2].attributes('aria-label')).toContain('8月15日')
    expect(cells[1].attributes('aria-label')).toContain('0')
    expect(cells[0].element.tagName).toBe('BUTTON')
    expect(cells[0].attributes('aria-pressed')).toBe('false')
    await cells[0].trigger('click')
    expect(cells[0].attributes('aria-pressed')).toBe('true')
    expect(heatmap.attributes('role')).toBe('list')
    expect(heatmap.element.parentElement).toBe(heatmapViewport.element)
  })

  it('matches recruitment history by recruited Agent and displays its source fields', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([{
        ...agents[0],
        profile: { ...agents[0].profile, testSource: 'e2e-roster', cleanupEligible: true },
        recruitmentId: 'recruitment-1',
      }])
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [{
        recruitment_id: 'recruitment-1', personal_space_id: 'personal-1', personal_project_id: 'project-a',
        task_id: 'task-1', coordinator_agent_id: 'coordinator', hr_agent_id: 'hr-agent',
        position_kind: 'temporary', work_kind: 'one-off', required_capabilities: [], reason_code: 'capacity',
        reason: '一次性终点明确', status: 'fulfilled', confirmation_mode: 'automatic', proposed_agent_id: 'shared-agent',
        recruited_agent_id: 'shared-agent', trigger_source_application: 'codex', test_source: 'e2e-roster',
        cleanup_eligible: true, revision: 1, created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z', fulfilled_at: '2026-08-16T01:00:00Z',
      }] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      return Promise.resolve([])
    })
    const { wrapper } = mountPage()
    await flushPromises()
    expect(wrapper.get('.project-agent-detail').text()).toContain('测试角色')
    await wrapper.get('.project-agent-detail-actions .quiet-button').trigger('click')
    await flushPromises()

    const detail = wrapper.get('.project-agent-detail').text()
    expect(detail).toContain('hr-agent')
    expect(detail).toContain('一次性终点明确')
    expect(detail).toContain('e2e-roster')
    expect(detail).toContain('Codex')
    await wrapper.get('.project-agent-detail-actions').get('button:nth-child(3)').trigger('click')
    await flushPromises()
    expect(deleteJson).toHaveBeenCalledWith(expect.stringContaining('/api/project-agents/shared-agent?personalSpaceId=personal-1'))
  })

  it('keeps space recruitment policy out of personnel detail while approving a pending real event', async () => {
    const recruitment = {
      recruitment_id: 'recruitment-pending', personal_space_id: 'personal-1', personal_project_id: 'project-a',
      task_id: 'task-pending', coordinator_agent_id: 'coordinator', hr_agent_id: 'hr-agent',
      position_kind: 'temporary', work_kind: 'one-off', required_capabilities: [], reason_code: 'no_match',
      reason: '需要一次性工作', status: 'awaiting_confirmation', confirmation_mode: 'require_confirmation',
      proposed_agent_id: 'shared-agent', recruited_agent_id: null, revision: 2,
      created_at: '2026-08-16T00:00:00Z', updated_at: '2026-08-16T00:00:00Z',
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [recruitment] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      return Promise.resolve([])
    })
    postJson.mockResolvedValue({})
    const { wrapper } = mountPage()
    await flushPromises()
    await wrapper.get('.project-agent-detail-actions .quiet-button').trigger('click')
    await flushPromises()

    expect(wrapper.find('.project-agent-policy-control').exists()).toBe(false)
    expect(patchJson).not.toHaveBeenCalledWith('/api/project-agent-recruitment-policy', expect.anything())
    await wrapper.get('.project-agent-recruitment-card .quiet-button').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/project-agent-recruitments/decision', expect.objectContaining({
      recruitmentId: 'recruitment-pending', expectedRevision: 2, decision: 'approve',
    }))
  })

  it('shows strategy-scoped learning evidence and uses the permission revision', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [{
        executor_id: 'executor-1', display_name: '真实执行器', registration_status: 'registered',
        permission_status: 'pending', permission_revision: 2, revision: 7,
        available_models: [{ provider: 'host', model: 'reported-model', available: true }],
      }] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([{
        personal_project_id: 'project-a', work_kind: 'review', agent_id: 'shared-agent',
        executor_id: 'executor-1', model_strategy: { mode: 'deep', reasoning_effort: 'high', capability_hints: [] },
        model_strategy_key: 'strategy-key-1', sample_count: 4, recent_count: 2,
        success_count: 3, rework_count: 1, failure_count: 0, rating_count: 1,
        weighted_success: 2.5, weighted_failure: 0.5, decay_half_life_days: 30,
        as_of: '2026-08-17T03:00:00Z', neutral_due_to_insufficient_evidence: false,
        evidence_contributions: [{
          evidence_id: 'evidence-1', evidence_kind: 'test_passed', signal: 'success',
          value: 1, decay_weight: 0.9, occurred_at: '2026-08-17T02:00:00Z', reference_ids: ['test-1'],
        }],
      }])
      return Promise.resolve([])
    })
    patchJson.mockResolvedValue({})
    postJson.mockResolvedValue({})
    const { wrapper } = mountPage()
    await flushPromises()
    await wrapper.get('.project-agent-detail-actions .quiet-button').trigger('click')
    await flushPromises()

    const learning = wrapper.get('.project-agent-learning-card')
    expect(learning.text()).toContain('4')
    expect(learning.text()).toContain('deep')
    expect(learning.text()).toContain('test_passed')
    await wrapper.get('.project-agent-evidence-list button').trigger('click')
    await flushPromises()
    expect(patchJson).toHaveBeenCalledWith('/api/project-agent-learning/evidence-1', expect.objectContaining({
      action: 'ignore', modelStrategyKey: 'strategy-key-1',
    }))

    await wrapper.get('.project-agent-executor-row button:nth-of-type(2)').trigger('click')
    await flushPromises()
    expect(postJson).toHaveBeenCalledWith('/api/executors/authorization', expect.objectContaining({
      executorId: 'executor-1', expectedRevision: 2, status: 'authorized',
    }))
  })

  it('automatically loads real detail data for the initial and newly selected Agent', async () => {
    const secondAgent = {
      ...agents[0],
      agentId: 'second-agent',
      profile: { ...agents[0].profile, name: '最后 Agent' },
      assignments: [],
    }
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve([...agents, secondAgent])
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-activity?')) {
        const agentId = new URL(url, 'http://local.test').searchParams.get('agentId')
        return Promise.resolve({ agent_id: agentId, personal_space_id: 'personal-1', days: [] })
      }
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })

    const { wrapper } = mountPage()
    await flushPromises()

    expect(getJson.mock.calls.some(([url]) => String(url).includes('/api/project-agent-activity?') && String(url).includes('agentId=shared-agent'))).toBe(true)
    expect(wrapper.get('[data-detail-section="activity"]').text()).toContain('没有已验证的完成、失败或取消历史')

    await wrapper.findAll('.project-agent-row')[1].trigger('click')
    await flushPromises()
    expect(getJson.mock.calls.some(([url]) => String(url).includes('/api/project-agent-activity?') && String(url).includes('agentId=second-agent'))).toBe(true)
  })

  it('keeps each detail section in loading or error state until that source reports', async () => {
    let resolveActivity!: (value: unknown) => void
    const activity = new Promise((resolve) => { resolveActivity = resolve })
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-activity?')) return activity
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })

    const { wrapper } = mountPage()
    await flushPromises()

    const loadingActivity = wrapper.get('[data-detail-section="activity"]')
    expect(loadingActivity.get('[role="status"]').text()).toContain('正在读取')
    expect(loadingActivity.text()).not.toContain('没有已验证的完成、失败或取消历史')

    resolveActivity({ agent_id: 'shared-agent', personal_space_id: 'personal-1', days: [] })
    await flushPromises()
    expect(wrapper.get('[data-detail-section="activity"]').text()).toContain('没有已验证的完成、失败或取消历史')
  })

  it('shows a partial detail failure instead of a false empty state', async () => {
    getJson.mockImplementation((url: string) => {
      if (url.includes('/api/project-agents?')) return Promise.resolve(agents)
      if (url.includes('/api/project-agent-tasks?')) return Promise.resolve({ tasks: [] })
      if (url.includes('/api/project-agent-assignments?')) return Promise.resolve({ assignments: [] })
      if (url.includes('/api/project-agent-activity?')) return Promise.reject(new Error('activity unavailable'))
      if (url.includes('/api/project-agent-recruitments?')) return Promise.resolve({ recruitments: [] })
      if (url.includes('/api/project-agent-recruitment-policy?')) return Promise.resolve({ personal_space_id: 'personal-1', confirmation_mode: 'automatic' })
      if (url.includes('/api/executors?')) return Promise.resolve({ executors: [] })
      if (url.includes('/api/executor-routing-rules?')) return Promise.resolve({ rules: [] })
      if (url.includes('/api/project-agent-routing-learning?')) return Promise.resolve([])
      return Promise.resolve([])
    })

    const { wrapper } = mountPage()
    await flushPromises()

    const activitySection = wrapper.get('[data-detail-section="activity"]')
    expect(activitySection.get('[role="alert"]').text()).toContain('activity unavailable')
    expect(activitySection.text()).not.toContain('没有已验证的完成、失败或取消历史')
    expect(wrapper.get('[data-detail-section="tasks"]').text()).toContain('尚无任务历史')
  })
})

function mountPage() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useConsoleStore()
  store.runtimeStatus = 'ready'
  store.state = {
    mode: 'personal_only',
    activePersonalSpaceId: 'personal-1',
    personalSpaces: [{ id: 'personal-1', name: '我' }],
    personalProjects: [
      {
        project_id: 'project-a',
        personal_space_id: 'personal-1',
        profile: { name: '活动项目', sources: [], boundaries: [] },
      },
      {
        project_id: 'project-b',
        personal_space_id: 'personal-1',
        profile: { name: '设计项目', sources: [], boundaries: [] },
      },
    ],
    projects: [],
    subscriptions: [],
  }
  return {
    store,
    wrapper: mount(ProjectAgentsPage, {
      global: { plugins: [pinia], stubs: { SearchableSelect: SearchableSelectStub } },
    }),
  }
}
