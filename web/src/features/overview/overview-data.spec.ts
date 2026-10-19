import { describe, expect, it } from 'vitest'
import { normalizeOverviewTasks, currentWork, overviewTaskTitle, overviewOwnerId, overviewOpenRequest, overviewTaskHref } from './overview-data'
import type { AgentAttention } from '@/features/project-agents/attention-store'

// Synthetic records exercise the public page contract; no personal-space writes.
const task = (id: string, status: string, extra = {}) => normalizeOverviewTasks({ items: [{
  task_id: id, personal_space_id: 's', personal_project_id: 'p', status,
  updated_at: '2026-10-18T00:00:00Z', participants: [], ...extra,
}] }, 's')[0]!

describe('workbench field projection', () => {
  it('keeps failed work before ordinary work with stable grouping and no input mutation', () => {
    const rows = [task('running', 'running'), task('failed', 'failed'), task('review', 'awaiting_review'), task('blocked', 'blocked'), task('done', 'completed')]
    expect(currentWork(rows).map(row => row.taskId)).toEqual(['failed', 'blocked', 'review', 'running'])
    expect(rows.map(row => row.taskId)).toEqual(['running', 'failed', 'review', 'blocked', 'done'])
  })
  it('uses objective when normalized title is an identifier and never calls the first participant the owner', () => {
    const row = task('raw-id', 'running', { objective: 'Real objective', participants: [{ agent_id: 'participant' }] })
    expect(overviewTaskTitle(row)).toBe('Real objective')
    expect(overviewOwnerId(row)).toBeNull()
    expect(overviewTaskTitle(task('missing', 'running'))).toBe('')
    expect(overviewOwnerId(task('owned', 'running', { lead_agent_id: 'lead', owner_agent_id: 'owner' }))).toBe('lead')
  })
  it('matches an open request only across the exact space, project and task', () => {
    const row = task('t', 'running')
    const base = { personalSpaceId: 's', personalProjectId: 'p', taskId: 't', status: 'open', requestId: 'right' } as AgentAttention
    const candidates = [
      { ...base, personalSpaceId: 'other', requestId: 'wrong-space' },
      { ...base, personalProjectId: 'other', requestId: 'wrong-project' },
      { ...base, status: 'resolved', requestId: 'closed' },
      { ...base, taskId: null, requestId: 'unlinked' }, base,
    ] as AgentAttention[]
    expect(overviewOpenRequest(row, candidates, 's')?.requestId).toBe('right')
    expect(overviewOpenRequest({ ...row, personalSpaceId: '' }, [base], 's')).toBeUndefined()
    expect(overviewTaskHref(row)).toBe('/project-agents/manage?project=p&task=t#task-t')
  })
})
