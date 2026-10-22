import type { IconName } from '@/ui'
import { knowledgePath, personalProjectsPath } from '@/router/paths'

// The six top-level destinations (Fable 5.1 decision, 2026-10-18). Each owns
// the routes under it; its sections become tabs in the top bar, so every page
// stays reachable without a long text sidebar.
export interface NavSection { key: string; to: string; owns: readonly string[] }
export interface NavDestination { key: string; icon: IconName; to: string; owns: readonly string[]; exact?: boolean; sections: readonly NavSection[] }

export interface NavContext { spaceId: string; publicProjects: boolean }

export function navDestinations({ spaceId, publicProjects }: NavContext): NavDestination[] {
  const projects = personalProjectsPath(spaceId, 'graph')
  const knowledge = knowledgePath('personal', spaceId, 'directory')
  return [
    { key: 'constellation', icon: 'constellation', to: '/', owns: ['/'], exact: true, sections: [] },
    { key: 'agents', icon: 'agents', to: '/project-agents', owns: ['/project-agents', '/agents/', '/employees/'], sections: [
      { key: 'agentDirectory', to: '/project-agents', owns: ['/project-agents', '/agents/', '/employees/'] },
      // The one entry to team management: assign work, staff projects, automation rules.
      { key: 'orchestrate', to: '/project-agents/manage', owns: ['/project-agents/manage'] },
      { key: 'schedules', to: '/project-agents/schedules', owns: ['/project-agents/schedules'] },
      { key: 'occupations', to: '/project-agents/occupations', owns: ['/project-agents/occupations'] },
    ] },
    { key: 'chat', icon: 'chat', to: '/roundtables', owns: ['/roundtables', '/inbox'], sections: [
      { key: 'roundtables', to: '/roundtables', owns: ['/roundtables'] },
      { key: 'askedYou', to: '/inbox', owns: ['/inbox'] },
    ] },
    { key: 'projects', icon: 'project', to: projects, owns: ['/personal/', '/public-projects'], sections: [
      { key: 'myProjects', to: projects, owns: ['/personal/'] },
      ...(publicProjects ? [{ key: 'publicProjects', to: '/public-projects', owns: ['/public-projects'] }] : []),
    ] },
    { key: 'memory', icon: 'memory', to: knowledge, owns: ['/knowledge', '/preferences', '/organize', '/tags'], sections: [
      { key: 'knowledge', to: knowledge, owns: ['/knowledge'] },
      { key: 'preferences', to: '/preferences', owns: ['/preferences'] },
      { key: 'writing', to: '/preferences/writing', owns: ['/preferences/writing'] },
      { key: 'organize', to: '/organize', owns: ['/organize'] },
      { key: 'tags', to: '/tags', owns: ['/tags'] },
    ] },
    { key: 'settings', icon: 'settings', to: '/settings', owns: ['/settings', '/connections', '/about'], sections: [
      { key: 'settings', to: '/settings', owns: ['/settings'] },
      { key: 'connections', to: '/connections', owns: ['/connections'] },
      { key: 'about', to: '/about', owns: ['/about'] },
    ] },
  ]
}

function owns(prefixes: readonly string[], path: string, exact = false): boolean {
  return prefixes.some(prefix => exact || prefix === '/' ? path === prefix : path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
}

export function activeDestination(destinations: readonly NavDestination[], path: string): NavDestination | undefined {
  return destinations.find(destination => owns(destination.owns, path, destination.exact))
}

// The longest owning prefix wins, so /preferences/writing selects 品味, not 偏好.
export function activeSection(destination: NavDestination | undefined, path: string): NavSection | undefined {
  return destination?.sections
    .filter(section => owns(section.owns, path))
    .sort((a, b) => Math.max(...b.owns.map(o => o.length)) - Math.max(...a.owns.map(o => o.length)))[0]
}
