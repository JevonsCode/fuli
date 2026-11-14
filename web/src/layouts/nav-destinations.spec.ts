import { describe, expect, it } from 'vitest'
import { activeDestination, activeSection, navDestinations } from './nav-destinations'

const all = navDestinations({ spaceId: 'personal-1', shown: () => true })

describe('nav destinations', () => {
  it('puts five destinations in the dock in sketch order and settings in the top bar', () => {
    expect(all.filter(d => d.placement === 'dock').map(d => d.key)).toEqual(['constellation', 'agents', 'chat', 'memory', 'projects'])
    expect(all.filter(d => d.placement === 'top').map(d => d.key)).toEqual(['settings'])
    expect(all.find(d => d.key === 'projects')?.sections.map(s => s.key)).toEqual(['myProjects'])
    expect(all.find(d => d.key === 'memory')?.sections.map(s => s.key)).toEqual(['knowledge', 'preferences', 'organize', 'tags'])
    expect(all.find(d => d.key === 'settings')?.sections.map(s => s.key)).toEqual(['settings', 'about', 'howto'])
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
    ['/preferences', 'memory', 'preferences'],
    ['/organize', 'memory', 'organize'],
    ['/tags', 'memory', 'tags'],
    ['/about', 'settings', 'about'],
    ['/howto', 'settings', 'howto'],
  ])('maps %s to %s / %s', (path, destination, section) => {
    const match = activeDestination(all, path)
    expect(match?.key).toBe(destination)
    expect(activeSection(match, path)?.key).toBe(section)
  })

  it('leaves out what waits for an advanced area that is not shown', () => {
    const fresh = navDestinations({ spaceId: 'personal-1', shown: () => false })
    expect(fresh.filter(d => d.placement === 'dock').map(d => d.key)).toEqual(['constellation', 'agents', 'memory', 'projects'])
    expect(fresh.find(d => d.key === 'memory')?.sections.map(s => s.key)).toEqual(['knowledge', 'preferences', 'tags'])
    // Only that area's entries wait: 整理 shown, 圆桌 not.
    const tidyOnly = navDestinations({ spaceId: 'personal-1', shown: area => area === 'tidy' })
    expect(tidyOnly.some(d => d.key === 'chat')).toBe(false)
    expect(tidyOnly.find(d => d.key === 'memory')?.sections.map(s => s.key)).toEqual(['knowledge', 'preferences', 'organize', 'tags'])
  })

  it('does not treat a shared prefix as ownership', () => {
    expect(activeDestination(all, '/settingsx')).toBeUndefined()
    expect(activeDestination(all, '/x')).toBeUndefined()
  })
})
