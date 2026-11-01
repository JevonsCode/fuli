import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { ProjectAgentTaskEvent, ProjectAgentTaskRecord } from '@/types'
import WorkbenchTimeline from './WorkbenchTimeline.vue'
import { taskTimeline, timelineCounts, timelineDays, timelineGap } from './task-timeline'

// Synthetic task events only.
const event = (id: string, at: string, patch: Partial<ProjectAgentTaskEvent> = {}): ProjectAgentTaskEvent => ({
  eventId: id, taskId: 'task-a', status: 'running', actorKind: 'agent', agentId: 'agent-a', summary: `Synthetic step ${id}`, createdAt: at, ...patch,
} as ProjectAgentTaskEvent)
const task = (events: ProjectAgentTaskEvent[], participants: unknown[] = []) => ({ taskId: 'task-a', events, participants }) as unknown as ProjectAgentTaskRecord
const fla = (agentId: string, from: string, patch: Record<string, unknown> = {}) => ({ agentId, role: 'collaborator', status: 'running', joinedAt: from, ...patch })

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

  it('stands beside each event the other FLAs at work at that moment', () => {
    const entries = taskTimeline(task([
      event('early', '2026-11-01T08:30:00Z'),
      event('mid', '2026-11-01T10:30:00Z'),
      event('late', '2026-11-01T12:30:00Z', { agentId: 'agent-c' }),
    ], [
      fla('agent-a', '2026-11-01T08:00:00Z'),
      fla('agent-b', '2026-11-01T09:00:00Z', { status: 'completed', runningSince: '2026-11-01T10:00:00Z', endedAt: '2026-11-01T11:00:00Z' }),
      fla('agent-c', '2026-11-01T10:00:00Z'),
      fla('agent-d', '2026-11-01T08:00:00Z', { status: 'completed' }),
      fla('agent-b', '2026-11-01T12:00:00Z'),
    ]))
    const crew = Object.fromEntries(entries.map(entry => [entry.id, entry.crew]))
    // The actor is named on the line, not stacked; an FLA ended without a time is not claimed; a reassigned FLA stands once.
    expect(crew).toEqual({ early: [], mid: ['agent-b', 'agent-c'], late: ['agent-a', 'agent-b'] })
  })

  it('stacks up to three faces, then one dot for the rest', () => {
    const crew = ['b', 'c', 'd', 'e'].map(id => fla(`agent-${id}`, '2026-11-01T08:00:00Z'))
    const wrapper = mount(WorkbenchTimeline, { props: { entries: taskTimeline(task([event('a', '2026-11-01T09:00:00Z')], crew)),
      taskKey: 'task-a', agentName: (id?: string | null) => `FLA ${id}` } })
    const stack = wrapper.get('[data-timeline-crew]')
    expect(stack.findAll('.timeline-crew-face')).toHaveLength(3)
    expect(stack.find('[data-timeline-crew-more]').exists()).toBe(true)
    expect(stack.attributes('title')).toBe('同时在干活：FLA agent-b、FLA agent-c、FLA agent-d和FLA agent-e')
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

describe('the timeline as it plays', () => {
  it('says the quiet stretch of an hour or more between two steps, and counts each FLA\'s steps', () => {
    const entries = taskTimeline(task([
      event('a', '2026-11-01T08:00:00Z'),
      event('b', '2026-11-01T08:40:00Z'),
      event('c', '2026-11-01T11:50:00Z', { agentId: 'agent-b' }),
      event('d', '2026-11-01T12:00:00Z', { actorKind: 'system', agentId: null }),
    ]))
    expect(timelineGap(entries[1]!, entries[2])).toBe('隔了 3小时')
    expect(timelineGap(entries[2]!, entries[3])).toBeNull()
    expect(timelineGap(entries[0]!, entries[1])).toBeNull()
    expect(timelineGap(entries[3]!, undefined)).toBeNull()
    expect([...timelineCounts(entries)]).toEqual([['agent-b', 1], ['agent-a', 2]])
  })

  it('hangs an FLA\'s face on the rail, a dot for the system, and lets the newest step of live work breathe', () => {
    const entries = taskTimeline(task([
      event('a', '2026-11-01T08:00:00Z', { actorKind: 'system', agentId: null }),
      event('b', '2026-11-01T10:00:00Z'),
    ]))
    const wrapper = mount(WorkbenchTimeline, { props: { entries, taskKey: 'task-a', agentName: () => 'Synthetic FLA', live: true } })
    const newest = wrapper.get('[data-timeline-entry="b"]')
    expect(newest.classes()).toContain('is-now')
    expect(newest.find('.timeline-face img').exists()).toBe(true)
    expect(wrapper.get('[data-timeline-entry="a"] .timeline-dot').attributes('data-actor')).toBe('system')
    expect(wrapper.get('[data-timeline-gap]').text()).toBe('隔了 2小时')
    wrapper.unmount()
    const still = mount(WorkbenchTimeline, { props: { entries, taskKey: 'task-a', agentName: () => 'Synthetic FLA' } })
    expect(still.find('.is-now').exists()).toBe(false)
  })
})
