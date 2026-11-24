import { describe, expect, it } from 'vitest'
import { normalizeOverviewTasks, overviewAgentIds, overviewTaskTitle, overviewOwnerId, overviewTaskHref } from './overview-data'

// Synthetic records exercise the public page contract; no personal-space writes.
const task = (id: string, status: string, extra = {}) => normalizeOverviewTasks({ items: [{
  task_id: id, personal_space_id: 's', personal_project_id: 'p', status,
  updated_at: '2026-10-18T00:00:00Z', participants: [], ...extra,
}] }, 's')[0]!

describe('workbench field projection', () => {
  it('lists every FLA the page can name once: requests, then leads, then participants and history', () => {
    const rows = [task('a', 'running', { lead_agent_id: 'lead-a', participants: [{ agent_id: 'lead-a' }, { agent_id: 'helper' }],
      events: [{ event_id: 'e1', task_id: 'a', agent_id: 'past', status: 'running', created_at: '2026-10-18T00:00:00Z' }] }),
      task('b', 'running', { lead_agent_id: 'lead-b' })]
    expect(overviewAgentIds([{ agentId: 'asker' }, { agentId: 'lead-b' }], rows)).toEqual(['asker', 'lead-b', 'lead-a', 'helper', 'past'])
    const many = Array.from({ length: 300 }, (_, index) => task('t' + index, 'running', { lead_agent_id: 'lead-' + index }))
    expect(overviewAgentIds([], many)).toHaveLength(240)
  })
  it('uses objective when normalized title is an identifier and never calls the first participant the owner', () => {
    const row = task('raw-id', 'running', { objective: 'Real objective', participants: [{ agent_id: 'participant' }] })
    expect(overviewTaskTitle(row)).toBe('Real objective')
    expect(overviewOwnerId(row)).toBeNull()
    expect(overviewTaskTitle(task('missing', 'running'))).toBe('')
    expect(overviewOwnerId(task('owned', 'running', { lead_agent_id: 'lead', owner_agent_id: 'owner' }))).toBe('lead')
  })
  it('links a task to its card on the management page', () => {
    expect(overviewTaskHref(task('t', 'running'))).toBe('/project-agents/manage?project=p&task=t#task-t')
  })
})
