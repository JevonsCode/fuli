import { describe, expect, it } from 'vitest'

import type { CountEvidence, KnowledgeEvidence, ProjectEvidence } from './evidence-reader'
import { buildHistoryPreview, projectOrigin } from './preview-model'

const CONVERSATION = `conversation-${'a'.repeat(64)}`
const OTHER_CONVERSATION = `conversation-${'b'.repeat(64)}`
const FALLBACK_NAME = '会话项目 / Conversation project'

const count = (value = 0, status: CountEvidence['status'] = 'complete'): CountEvidence => ({ status, count: value })
const knowledge = (value = 0, extra: Partial<KnowledgeEvidence> = {}): KnowledgeEvidence =>
  ({ status: 'complete', count: value, pages: 1, relations: 0, referencedElsewhere: 0, ...extra })

function evidence(projectId: string, extra: Partial<ProjectEvidence> = {}, profile: Record<string, unknown> = {}): ProjectEvidence {
  return {
    project: { project_id: projectId, personal_space_id: 'space-1', profile: { name: projectId, ...profile } },
    knowledge: knowledge(), tasks: count(), assignments: count(), ...extra,
  }
}

describe('projectOrigin', () => {
  it('recognizes system fallbacks only by their generated identity, never by the shared name', () => {
    expect(projectOrigin(evidence(CONVERSATION, {}, { name: FALLBACK_NAME }).project)).toBe('conversation_fallback')
    expect(projectOrigin(evidence('my-notes', {}, { name: FALLBACK_NAME }).project)).toBe('unknown')
    expect(projectOrigin({ ...evidence('temporary-x').project, scope_type: 'temporary' })).toBe('temporary_task')
    expect(projectOrigin(evidence('repo', {}, { sources: [{ kind: 'repository', uri: 'git@x:y' }] }).project))
      .toBe('registered_with_sources')
  })
})

describe('buildHistoryPreview', () => {
  it('suggests archiving only an empty fallback whose evidence is complete', () => {
    const preview = buildHistoryPreview([
      evidence(CONVERSATION, {}, { name: FALLBACK_NAME }),
      evidence(OTHER_CONVERSATION, { tasks: count(3) }, { name: FALLBACK_NAME }),
    ])
    expect(preview.projects.map(({ suggestion }) => suggestion)).toEqual(['archive_candidate', 'review_assignment'])
    // Two projects share the fallback name; that alone is never duplicate evidence.
    expect(preview.projects.every(({ sameNameCount, mergeWith }) => sameNameCount === 1 && !mergeWith.length)).toBe(true)
  })

  it('withholds a suggestion when an empty-looking project has incomplete or failed evidence', () => {
    const preview = buildHistoryPreview([
      evidence(CONVERSATION, { knowledge: knowledge(0, { status: 'incomplete', reason: 'broken_cursor' }) }),
      evidence(OTHER_CONVERSATION, { assignments: { status: 'failed', count: 0, reason: 'request_failed' } }),
    ])
    expect(preview.projects.map(({ suggestion, complete }) => [suggestion, complete]))
      .toEqual([['insufficient_evidence', false], ['insufficient_evidence', false]])
    expect(preview).toMatchObject({ complete: false, incompleteCount: 2 })
  })

  it('keeps a project whose partial evidence already proves history exists', () => {
    const preview = buildHistoryPreview([
      evidence('repo', { tasks: count(200, 'incomplete'), knowledge: knowledge(0, { status: 'failed' }) }),
    ])
    expect(preview.projects[0]).toMatchObject({ suggestion: 'keep', complete: false })
  })

  it('treats relations and references from other projects as history that blocks archiving', () => {
    const preview = buildHistoryPreview([
      evidence(CONVERSATION, { knowledge: knowledge(0, { relations: 1 }) }),
      evidence(OTHER_CONVERSATION, { knowledge: knowledge(0, { referencedElsewhere: 2 }) }),
    ])
    expect(preview.projects.map(({ suggestion }) => suggestion)).toEqual(['review_assignment', 'review_assignment'])
  })

  it('never suggests archiving an empty project whose origin is unknown or user-registered', () => {
    const temporary = evidence('temporary-x')
    temporary.project.scope_type = 'temporary'
    const preview = buildHistoryPreview([evidence('unknown-empty'), temporary])
    expect(preview.projects.map(({ suggestion }) => suggestion)).toEqual(['review_manually', 'archive_candidate'])
  })

  it('offers merge review only for registered projects sharing the same recorded source', () => {
    const repo = { kind: 'repository', uri: 'https://github.com/o/r.git' }
    const preview = buildHistoryPreview([
      evidence('one', { tasks: count(1) }, { name: 'Same', sources: [repo] }),
      evidence('two', {}, { name: 'Same', sources: [{ ...repo, uri: 'https://github.com/o/r/' }] }),
      evidence('three', {}, { name: 'Same' }),
    ])
    expect(preview.projects.map(({ suggestion, mergeWith }) => [suggestion, mergeWith])).toEqual([
      ['merge_review', ['two']],
      ['merge_review', ['one']],
      ['review_manually', []],
    ])
    expect(preview.projects[2].sameNameCount).toBe(2)
    expect(preview.counts).toMatchObject({ merge_review: 2, review_manually: 1 })
  })
})
