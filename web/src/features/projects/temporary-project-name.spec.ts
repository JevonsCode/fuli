import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { PersonalProject } from '@/types'
import { projectDisplayName } from './project-origin'
import { projectScopeGroups } from './project-scope-choices'
import { givenProjectTitle, temporaryProjectName, temporaryProjectNumber } from './temporary-project-name'

// Synthetic projects only: a digest of one repeated character, synthetic names.
const temporaryId = (seed: string) => `temporary-${seed.repeat(64)}`
const project = (id: string, name: string, extra: Partial<PersonalProject> = {}): PersonalProject => ({
  project_id: id, personal_space_id: 'space-a', profile: { name }, ...extra,
})

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('temporary project names', () => {
  it('names an unnamed temporary project in the console\'s language, by its number and last use', () => {
    const unnamed = project(temporaryId('a'), '', { scope_type: 'temporary', updated_at: '2026-10-17T07:20:00Z' })
    expect(projectDisplayName(unnamed)).toMatch(/^临时项目 #aaaaaaaa · /)
    setLocale('en-US', { persist: false })
    expect(projectDisplayName(unnamed)).toMatch(/^Temporary project #aaaaaaaa · /)
    expect(projectDisplayName(project(temporaryId('b'), '', { scope_type: 'temporary' }))).toBe('Temporary project #bbbbbbbb')
  })

  it('treats every name FULI ever generated as no name at all', () => {
    for (const name of ['会话项目 / Conversation project', '临时任务 / Temporary task', '临时会话 / Temporary session']) {
      expect(givenProjectTitle({ project_id: temporaryId('c'), profile: { name } })).toBe('')
      expect(temporaryProjectName({ project_id: temporaryId('c'), profile: { name } })).toBe('临时项目 #cccccccc')
    }
  })

  it('keeps a name a person gave, and a registered project keeps its own', () => {
    expect(projectDisplayName(project(temporaryId('d'), 'Synthetic garden notes', { scope_type: 'temporary' })))
      .toBe('Synthetic garden notes')
    expect(projectDisplayName(project('synthetic-formal', 'Synthetic formal'))).toBe('Synthetic formal')
  })

  it('uses the number a picker gave, so a row and its folded list agree', () => {
    const projects = [
      project(temporaryId('e'), '', { scope_type: 'temporary' }),
      project(`temporary-${'e'.repeat(8)}${'f'.repeat(56)}`, '', { scope_type: 'temporary' }),
    ]
    const { temporary } = projectScopeGroups(projects)
    for (const choice of temporary) {
      expect(projectDisplayName(choice.project, choice.label.slice(1))).toBe(`临时项目 ${choice.label}`)
    }
    expect(temporaryProjectNumber(temporaryId('e'))).toBe('eeeeeeee')
  })
})
