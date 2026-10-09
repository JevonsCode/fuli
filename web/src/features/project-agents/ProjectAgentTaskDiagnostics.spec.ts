import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { ProjectAgentTaskRecord } from '@/types'
import ProjectAgentTaskDiagnostics from './ProjectAgentTaskDiagnostics.vue'

const task: ProjectAgentTaskRecord = {
  taskId: 'task-a', title: 'First task', status: 'running', personalProjectId: 'project-a',
  participants: [{ agentId: 'agent-a', role: 'lead', status: 'running' }],
}
const mountDiagnostics = (overrides: Partial<ProjectAgentTaskRecord> = {}) => mount(ProjectAgentTaskDiagnostics, {
  props: { task: { ...task, ...overrides }, projectName: '项目 A' },
})

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('task execution diagnostics', () => {
  it('distinguishes assignment and configured routing from a real worker report', () => {
    const wrapper = mountDiagnostics({
      runId: 'run-a', executionId: 'execution-a',
      effectiveExecutorPolicy: { mode: 'flexible', allowList: [{ executorId: 'allowed-executor' }] },
      routingDecision: { outcome: 'parallel_reuse', candidateAgentIds: ['candidate-a'] },
      executionSummary: [],
    })
    expect(wrapper.get('[data-task-assignment-state]').text()).toContain('已记录任务分配')
    expect(wrapper.get('[data-task-execution-state]').text()).toContain('尚未收到工作进程报告')
    expect(wrapper.get('[data-task-summary-reason]').text()).toContain('等待客户端上报执行结果')
    expect(wrapper.text()).not.toContain('工作进程报告运行中')
  })

  it('does not treat coordinator or candidate metadata as a task assignment', () => {
    const wrapper = mountDiagnostics({ participants: [], coordinatorAgentId: 'coordinator-a', routingDecision: { candidateAgentIds: ['candidate-a'] } })
    expect(wrapper.get('[data-task-assignment-state]').text()).toContain('尚未记录任务分配')
    expect(wrapper.get('[data-task-summary-reason]').text()).toContain('还没有分配或执行记录')
  })

  it('labels an explicitly temporary scope and leaves opaque IDs uninterpreted', () => {
    const temporary = mountDiagnostics({ projectScope: { type: 'temporary', lifetime: 'task', persisted: true } })
    expect(temporary.get('[data-task-project-state]').text()).toContain('独立临时项目')
    expect(temporary.text()).toContain('独立的临时项目')
    expect(mountDiagnostics({ personalProjectId: 'temporary-looking-id' }).get('[data-task-project-state]').text()).toContain('已关联项目')
    expect(mountDiagnostics({ personalProjectId: null }).get('[data-task-project-state]').text()).toContain('项目尚未识别')
  })

  it('shows a queued worker without claiming execution started', () => {
    const wrapper = mountDiagnostics({ executionSummary: [{ workerId: 'worker-a', status: 'queued' }] })
    expect(wrapper.get('[data-task-execution-state]').text()).toContain('工作进程已排队')
    expect(wrapper.find('[data-task-summary-reason]').exists()).toBe(false)
  })

  it('uses the latest per-worker event and explains an absent summary without inventing one', () => {
    const wrapper = mountDiagnostics({ events: [
      { eventId: 'event-2', taskId: 'task-a', workerId: 'worker-a', status: 'running', workerStatus: 'completed', summary: 'Done', createdAt: '2026-10-09T02:00:00Z' },
      { eventId: 'event-1', taskId: 'task-a', workerId: 'worker-a', status: 'running', workerStatus: 'running', summary: 'Started', createdAt: '2026-10-09T01:00:00Z' },
    ] })
    expect(wrapper.get('[data-task-execution-state]').text()).toContain('已收到结束状态')
    expect(wrapper.get('[data-task-summary-reason]').text()).toContain('已收到执行事件，等待汇总')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('does not promote the parent task status to worker status', () => {
    const wrapper = mountDiagnostics({ events: [{
      eventId: 'event-a', taskId: 'task-a', workerId: 'worker-a', status: 'running', summary: '', createdAt: '',
    }] })
    expect(wrapper.get('[data-task-execution-state]').text()).toContain('已收到工作进程报告')
    expect(wrapper.text()).not.toContain('工作进程报告运行中')
  })

  it('respects an authoritative empty summary over historical event fallback', () => {
    const wrapper = mountDiagnostics({ executionSummary: [], events: [{
      eventId: 'event-a', taskId: 'task-a', workerId: 'worker-a', status: 'running', workerStatus: 'running', summary: '', createdAt: '',
    }] })
    expect(wrapper.get('[data-task-execution-state]').text()).toContain('尚未收到工作进程报告')
  })

  it('renders the evidence-based running state in English', () => {
    setLocale('en-US', { persist: false })
    const wrapper = mountDiagnostics({ executionSummary: [{ workerId: 'worker-a', status: 'running' }] })
    expect(wrapper.get('[data-task-execution-state]').text()).toContain('Worker reported running')
    expect(wrapper.find('[data-task-summary-reason]').exists()).toBe(false)
  })
})
