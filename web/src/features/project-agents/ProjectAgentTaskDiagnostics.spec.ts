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
const fact = (wrapper: ReturnType<typeof mountDiagnostics>, key: string) => wrapper.find(`[data-task-diagnostic="${key}"]`)

afterEach(() => setLocale('zh-CN', { persist: false }))

// One quiet line of what is known (Jevons 11-01, 简洁): an identified project
// (already in the card's meta), a missing assignment and an unreported run say nothing.
describe('task execution diagnostics', () => {
  it('names an assignment, but not routing metadata or an unreported run as execution', () => {
    const wrapper = mountDiagnostics({
      runId: 'run-a', executionId: 'execution-a',
      effectiveExecutorPolicy: { mode: 'flexible', allowList: [{ executorId: 'allowed-executor' }] },
      routingDecision: { outcome: 'parallel_reuse', candidateAgentIds: ['candidate-a'] },
      executionSummary: [],
    })
    expect(fact(wrapper, 'assignment').text()).toBe('已记录任务分配')
    expect(fact(wrapper, 'execution').exists()).toBe(false)
    expect(fact(wrapper, 'project').exists()).toBe(false)
  })

  it('says nothing at all when nothing is known yet', () => {
    const wrapper = mountDiagnostics({ participants: [], coordinatorAgentId: 'coordinator-a', routingDecision: { candidateAgentIds: ['candidate-a'] } })
    expect(wrapper.find('[data-task-diagnostics]').exists()).toBe(false)
  })

  it('names a temporary or unresolved project and leaves opaque IDs uninterpreted', () => {
    expect(fact(mountDiagnostics({ projectScope: { type: 'temporary', lifetime: 'task', persisted: true } }), 'project').text()).toBe('独立临时项目')
    expect(fact(mountDiagnostics({ personalProjectId: 'temporary-looking-id' }), 'project').exists()).toBe(false)
    expect(fact(mountDiagnostics({ personalProjectId: null }), 'project').text()).toBe('项目尚未识别')
  })

  it('shows a queued worker without claiming execution started', () => {
    expect(fact(mountDiagnostics({ executionSummary: [{ workerId: 'worker-a', status: 'queued' }] }), 'execution').text()).toBe('工作进程已排队')
  })

  it('uses the latest per-worker event', () => {
    const wrapper = mountDiagnostics({ events: [
      { eventId: 'event-2', taskId: 'task-a', workerId: 'worker-a', status: 'running', workerStatus: 'completed', summary: 'Done', createdAt: '2026-10-09T02:00:00Z' },
      { eventId: 'event-1', taskId: 'task-a', workerId: 'worker-a', status: 'running', workerStatus: 'running', summary: 'Started', createdAt: '2026-10-09T01:00:00Z' },
    ] })
    expect(fact(wrapper, 'execution').text()).toBe('已收到结束状态')
  })

  it('does not promote the parent task status to worker status', () => {
    const wrapper = mountDiagnostics({ events: [{
      eventId: 'event-a', taskId: 'task-a', workerId: 'worker-a', status: 'running', summary: '', createdAt: '',
    }] })
    expect(fact(wrapper, 'execution').text()).toBe('已收到工作进程报告')
  })

  it('respects an authoritative empty summary over historical event fallback', () => {
    const wrapper = mountDiagnostics({ executionSummary: [], events: [{
      eventId: 'event-a', taskId: 'task-a', workerId: 'worker-a', status: 'running', workerStatus: 'running', summary: '', createdAt: '',
    }] })
    expect(fact(wrapper, 'execution').exists()).toBe(false)
  })

  it('renders the evidence-based running state in English', () => {
    setLocale('en-US', { persist: false })
    expect(fact(mountDiagnostics({ executionSummary: [{ workerId: 'worker-a', status: 'running' }] }), 'execution').text()).toBe('Worker reported running')
  })
})
