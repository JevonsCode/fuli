import { describe, expect, it } from 'vitest'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'

const all = navDestinations({ spaceId: 'personal-1', publicProjects: true, review: true })

describe('nav destinations', () => {
  it('keeps six destinations and hides sections the capabilities do not allow', () => {
    expect(all.map(d => d.key)).toEqual(['constellation', 'agents', 'chat', 'projects', 'memory', 'settings'])
    const limited = navDestinations({ spaceId: 'personal-1', publicProjects: false, review: false })
    expect(limited.find(d => d.key === 'projects')?.sections.map(s => s.key)).toEqual(['myProjects'])
    expect(limited.find(d => d.key === 'memory')?.sections.map(s => s.key)).not.toContain('review')
  })

  it.each([
    ['/', 'constellation', undefined],
    ['/project-agents', 'agents', 'agentDirectory'],
    ['/agents/employee.bole', 'agents', 'agentDirectory'],
    ['/project-agents/occupations', 'agents', 'occupations'],
    ['/project-agents/manage', 'agents', 'orchestrate'],
    ['/inbox', 'chat', 'askedYou'],
    ['/roundtables/abc', 'chat', 'roundtables'],
    ['/personal/personal-1/projects/graph', 'projects', 'myProjects'],
    ['/public-projects', 'projects', 'publicProjects'],
    ['/preferences', 'memory', 'preferences'],
    ['/preferences/writing', 'memory', 'writing'],
    ['/organize', 'memory', 'organize'],
    ['/about', 'settings', 'about'],
  ])('maps %s to %s / %s', (path, destination, section) => {
    const match = activeDestination(all, path)
    expect(match?.key).toBe(destination)
    expect(activeSection(match, path)?.key).toBe(section)
  })

  it('does not treat a shared prefix as ownership', () => {
    expect(activeDestination(all, '/settingsx')).toBeUndefined()
    expect(activeDestination(all, '/x')).toBeUndefined()
  })
})
