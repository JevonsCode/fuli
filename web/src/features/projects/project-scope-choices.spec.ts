import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@/i18n'
import type { PersonalProject } from '@/types'
import { groupSelection, matchesProjectQuery, projectScopeGroups, projectScopeOptions } from './project-scope-choices'

// Synthetic projects only. A temporary project is told by where it came from, never by its name.
const hex = (seed: string) => seed.repeat(64).slice(0, 64)
const project = (id: string, name: string, extra: Partial<PersonalProject> = {}): PersonalProject => ({
  project_id: id, personal_space_id: 'space-a', profile: { name }, ...extra,
})
const temporary = (seed: string, extra: Partial<PersonalProject> = {}) =>
  project(`temporary-${hex(seed)}`, '临时会话 / Temporary session', { scope_type: 'temporary', ...extra })

afterEach(() => setLocale('zh-CN', { persist: false }))

describe('project scope groups', () => {
  it('sorts by origin: marked temporary, a fallback ID or a recorded origin; names never decide', () => {
    const groups = projectScopeGroups([
      project('alpha', 'Alpha'),
      project('named-like-temporary', '临时会话 / Temporary session'),
      temporary('a'),
      project(`conversation-${hex('b')}`, '会话项目 / Conversation project'),
      project('old-fallback', 'Old', { profile: { name: 'Old', origin: 'conversation_fallback' } }),
    ])
    expect(groups.formal.map(choice => choice.label)).toEqual(['Alpha', '临时会话 / Temporary session'])
    expect(groups.temporary.map(choice => choice.project.project_id).sort())
      .toEqual([`conversation-${hex('b')}`, 'old-fallback', `temporary-${hex('a')}`].sort())
  })

  it('never files an archived named project as temporary, and drops nothing a caller offers', () => {
    const groups = projectScopeGroups([
      project('kept', 'Kept', { status: 'archived' }),
      temporary('c', { status: 'archived' }),
      temporary('d', { profile: { name: 'x', lifecycle: 'archived' } }),
    ])
    expect(groups.formal.map(choice => choice.label)).toEqual(['Kept'])
    expect(groups.temporary).toHaveLength(2)
  })

  it('numbers temporary projects by their ID: unique when IDs share a prefix, a digest or a whole ID across spaces', () => {
    const sharedPrefix = [temporary('', { project_id: `temporary-${'ab12cd34'}${'0'.repeat(56)}` }),
      temporary('', { project_id: `temporary-${'ab12cd34'}${'1'.repeat(56)}` })]
    const sameDigest = [temporary('e'), project(`conversation-${hex('e')}`, '会话项目 / Conversation project')]
    const sameId = [temporary('f'), temporary('f', { personal_space_id: 'space-b' })]
    const all = [...sharedPrefix, ...sameDigest, ...sameId]
    const labels = projectScopeGroups(all).temporary.map(choice => choice.label)
    expect(new Set(labels).size).toBe(all.length)
    const byKey = (input: PersonalProject[]) => new Map(projectScopeGroups(input).temporary.map(choice => [choice.key, choice.label]))
    expect(byKey(all).get(`space-a/temporary-${hex('e')}`)).toBe('#eeeeeeee-t')
    expect(byKey(all).get(`space-a/conversation-${hex('e')}`)).toBe('#eeeeeeee-c')
    expect(byKey(all).get(`space-b/temporary-${hex('f')}`)).toBe('#ffffffff@space-b')
    // The same projects in another order, after a refresh or in English keep their numbers.
    const first = byKey(all)
    expect(byKey([...all].reverse())).toEqual(first)
    setLocale('en-US', { persist: false })
    expect(byKey(all)).toEqual(first)
  })

  it('grows a number only as far as it takes: digests equal for 12 characters show 13, a shared-word ID shows a short code', () => {
    const near = ['ab12cd34ef56' + '7' + '0'.repeat(51), 'ab12cd34ef56' + '8' + '0'.repeat(51)]
      .map(digest => temporary('', { project_id: `temporary-${digest}` }))
    const legacy = ['legacy-fallback-session-alpha', 'legacy-fallback-session-beta']
      .map(id => project(id, 'x', { profile: { name: 'x', origin: 'conversation_fallback' } }))
    const labels = new Map(projectScopeGroups([...near, ...legacy]).temporary.map(choice => [choice.project.project_id, choice.label]))
    expect(labels.get(near[0]!.project_id)).toBe('#ab12cd34ef567')
    expect(labels.get(near[1]!.project_id)).toBe('#ab12cd34ef568')
    for (const item of legacy) expect(labels.get(item.project_id)).toMatch(/^#[0-9a-f]{8}$/)
    expect(labels.get(legacy[0]!.project_id)).not.toBe(labels.get(legacy[1]!.project_id))
    // The same ID always gets the same code, and the full ID still finds it.
    expect(projectScopeGroups([legacy[0]!]).temporary[0]!.label).toMatch(/^#[0-9a-f]{8}$/)
    const choice = projectScopeGroups(legacy).temporary.find(entry => entry.project.project_id === 'legacy-fallback-session-beta')!
    expect(matchesProjectQuery(choice, 'legacy-fallback-session-beta')).toBe(true)
  })

  it('shows what is recorded beside the number: the last-use date and a title someone gave, never a generated name', () => {
    const [titled, plain, undated] = [
      temporary('1', { updated_at: '2026-11-18T09:00:00Z', profile: { name: '发布检查' } }),
      temporary('2', { updated_at: '2026-11-17T09:00:00Z' }),
      temporary('3', { updated_at: null, created_at: null }),
    ]
    const details = new Map(projectScopeGroups([titled!, plain!, undated!]).temporary.map(choice => [choice.project.project_id, choice.detail]))
    expect(details.get(titled!.project_id)).toMatch(/2026.*发布检查/)
    expect(details.get(plain!.project_id)).toMatch(/2026/)
    expect(details.get(plain!.project_id)).not.toContain('Temporary')
    // A project record names no source client, so none is shown or invented.
    expect(details.get(undated!.project_id)).toBe('')
  })

  it('finds a temporary project by number, title or full ID, and counts a group as all, none or part', () => {
    const groups = projectScopeGroups([temporary('7', { profile: { name: '周报' } }), temporary('8')])
    const [first, second] = groups.temporary
    expect(matchesProjectQuery(first!, '周报')).toBe(true)
    expect(matchesProjectQuery(second!, '#88888888')).toBe(true)
    expect(matchesProjectQuery(second!, hex('8').slice(20, 40))).toBe(true)
    expect(groupSelection(groups.temporary, new Set([first!.key]))).toEqual({ count: 1, total: 2, state: 'indeterminate' })
    expect(groupSelection(groups.temporary, new Set()).state).toBe(false)
    expect(groupSelection(groups.temporary, new Set(groups.temporary.map(choice => choice.key))).state).toBe(true)
  })

  it('gives comboboxes named projects first and temporary ones under the heading in the console language', () => {
    const options = projectScopeOptions([temporary('9'), project('alpha', 'Alpha')], item => ({ meta: `#${item.project_id}` }))
    expect(options.map(option => [option.label, option.group, option.meta])).toEqual([
      ['Alpha', undefined, '#alpha'], ['#99999999', '临时项目', undefined],
    ])
    setLocale('en-US', { persist: false })
    expect(projectScopeOptions([temporary('9')])[0]!.group).toBe('Temporary projects')
  })
})
