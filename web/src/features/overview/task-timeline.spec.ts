import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { ProjectAgentTaskEvent, ProjectAgentTaskRecord } from '@/types'
import WorkbenchTimeline from './WorkbenchTimeline.vue'
import { taskTimeline, timelineDays } from './task-timeline'

// Synthetic task events only.
const event = (id: string, at: string, patch: Partial<ProjectAgentTaskEvent> = {}): ProjectAgentTaskEvent => ({
  eventId: id, taskId: 'task-a', status: 'running', actorKind: 'agent', agentId: 'agent-a', summary: `Synthetic step ${id}`, createdAt: at, ...patch,
} as ProjectAgentTaskEvent)
const task = (events: ProjectAgentTaskEvent[]) => ({ taskId: 'task-a', events, participants: [] }) as unknown as ProjectAgentTaskRecord

beforeEach(() => setLocale('zh-CN', { persist: false }))

describe('the task timeline', () => {
  it('reads recorded codes as sentences, keeps the stored text as raw, and marks finish, block and unblock', () => {
    const entries = taskTimeline(task([
      event('a', '2026-11-01T08:00:00Z', { actorKind: 'system', agentId: null, status: 'awaiting_recruitment', summary: 'project_team_gap: project team lead remains accountable' }),
      event('b', '2026-11-01T09:00:00Z', { actorKind: 'hr', agentId: null, status: 'blocked', summary: 'recruitment cancelled: synthetic reason' }),
      event('c', '2026-11-01T10:00:00Z', { status: 'completed', summary: 'Shipped the synthetic thing' }),
      event('d', '2026-11-01T09:30:00Z', { blockerClearedBy: 'person' as never }),
    ]))
    expect(entries.map(entry => entry.id)).toEqual(['c', 'd', 'b', 'a'])
    expect(entries.map(entry => entry.tone)).toEqual(['done', 'unblocked', 'blocked', 'plain'])
    const gap = entries.find(entry => entry.id === 'a')!
    expect(gap.reason.text).toBe('小组里没有合适的成员，需要招聘')
    expect(gap.reason.raw).toBe('project_team_gap: project team lead remains accountable')
    expect(entries.find(entry => entry.id === 'c')!.reason).toEqual({ text: 'Shipped the synthetic thing', unknownCode: null, raw: null })
  })

  it('groups by local day: today, yesterday, then the date', () => {
    const now = new Date(2026, 10, 3, 12)
    const at = (day: number) => new Date(2026, 10, day, 9).toISOString()
    const days = timelineDays(taskTimeline(task([event('a', at(3)), event('b', at(2)), event('c', at(1))])), now)
    expect(days.map(day => day.label)).toEqual(['今天', '昨天', '11月1日'])
  })

  it('shows the latest eight, more on request, and opens a long sentence with 展开', async () => {
    const events = Array.from({ length: 11 }, (_, index) => event(`e${index}`, new Date(2026, 10, 1, 8, index).toISOString(),
      index === 10 ? { summary: 'x'.repeat(200) } : {}))
    const wrapper = mount(WorkbenchTimeline, { props: { entries: taskTimeline(task(events)), taskKey: 'task-a', agentName: () => 'Synthetic FLA' } })
    expect(wrapper.findAll('[data-timeline-entry]')).toHaveLength(8)
    const long = wrapper.get('[data-timeline-entry="e10"]')
    expect(long.get('.timeline-text').classes()).toContain('is-clamped')
    await long.get('.timeline-more').trigger('click')
    expect(long.get('.timeline-text').classes()).not.toContain('is-clamped')
    expect(wrapper.get('[data-timeline-earlier]').text()).toBe('显示更早的 3 条')
    await wrapper.get('[data-timeline-earlier]').trigger('click')
    expect(wrapper.findAll('[data-timeline-entry]')).toHaveLength(11)
    expect(wrapper.find('[data-timeline-earlier]').exists()).toBe(false)
  })
})
