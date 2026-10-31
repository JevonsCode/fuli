import { describe, expect, it } from 'vitest'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'

const all = navDestinations({ spaceId: 'personal-1', publicProjects: true })

describe('nav destinations', () => {
  it('puts five destinations in the dock in sketch order, settings in the top bar, and hides sections the capabilities do not allow', () => {
    expect(all.filter(d => d.placement === 'dock').map(d => d.key)).toEqual(['constellation', 'agents', 'chat', 'memory', 'projects'])
    expect(all.filter(d => d.placement === 'top').map(d => d.key)).toEqual(['settings'])
    const limited = navDestinations({ spaceId: 'personal-1', publicProjects: false })
    expect(limited.find(d => d.key === 'projects')?.sections.map(s => s.key)).toEqual(['myProjects'])
    expect(all.find(d => d.key === 'memory')?.sections.map(s => s.key)).toEqual(['knowledge', 'preferences', 'organize', 'tags'])
  })

  it.each([
    ['/', 'constellation', undefined],
    ['/project-agents', 'agents', 'agentDirectory'],
    ['/agents/employee.bole', 'agents', 'agentDirectory'],
    ['/project-agents/occupations', 'agents', 'occupations'],
    ['/project-agents/services', 'agents', 'services'],
    ['/project-agents/manage', 'agents', 'orchestrate'],
    ['/inbox', 'chat', 'askedYou'],
    ['/roundtables/abc', 'chat', 'roundtables'],
    ['/personal/personal-1/projects/graph', 'projects', 'myProjects'],
    ['/public-projects', 'projects', 'publicProjects'],
    ['/preferences', 'memory', 'preferences'],
    ['/organize', 'memory', 'organize'],
    ['/tags', 'memory', 'tags'],
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
