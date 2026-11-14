import type { AdvancedArea } from '@/features/advanced-areas/advanced-areas'
import type { IconName } from '@/ui'
import { knowledgePath, personalProjectsPath } from '@/router/paths'

// The top-level destinations (client redesign, 2026-11-01). Five live in the
// floating dock in sketch order: 工作台, FLAs, 圆桌, 沉淀, 项目; settings sits in
// the top bar. Each owns the routes under it; its sections become tabs in the
// top bar, so every page stays reachable without a long text sidebar.
// area: an advanced area (features/advanced-areas) the entry waits for; until
// it is shown the entry is left out, and its pages stay reachable by link.
export interface NavSection { key: string; to: string; owns: readonly string[]; area?: AdvancedArea }
export type NavPlacement = 'dock' | 'top'
export interface NavDestination { key: string; icon: IconName; to: string; owns: readonly string[]; exact?: boolean; placement: NavPlacement; sections: readonly NavSection[]; area?: AdvancedArea }

export interface NavContext { spaceId: string; shown: (area: AdvancedArea) => boolean }

export function navDestinations({ spaceId, shown }: NavContext): NavDestination[] {
  const offered = (entry: { area?: AdvancedArea }) => !entry.area || shown(entry.area)
  return allDestinations(spaceId).filter(offered).map(item => ({ ...item, sections: item.sections.filter(offered) }))
}

function allDestinations(spaceId: string): NavDestination[] {
  const projects = personalProjectsPath(spaceId, 'graph')
  const knowledge = knowledgePath('personal', spaceId, 'directory')
  return [
    { key: 'constellation', icon: 'constellation', to: '/', owns: ['/'], exact: true, placement: 'dock', sections: [] },
    { key: 'agents', icon: 'agents', to: '/project-agents', owns: ['/project-agents', '/agents/', '/employees/'], placement: 'dock', sections: [
      { key: 'agentDirectory', to: '/project-agents', owns: ['/project-agents', '/agents/', '/employees/'] },
      // The one entry to team management: assign work, staff projects, automation rules.
      { key: 'orchestrate', to: '/project-agents/manage', owns: ['/project-agents/manage'] },
      { key: 'occupations', to: '/project-agents/occupations', owns: ['/project-agents/occupations'] },
      // 服务管理: services FLAs started and their workbenches (rec#11 D-71).
      { key: 'services', to: '/project-agents/services', owns: ['/project-agents/services'] },
      // 应用: the apps FLAs built, approved and removed by the person (docs/agent-apps.md).
      { key: 'apps', to: '/project-agents/apps', owns: ['/project-agents/apps'] },
    ] },
    // 待决策 (/inbox) also opens from the top bar, so it stays reachable while 圆桌 waits.
    { key: 'chat', icon: 'roundtable', to: '/roundtables', owns: ['/roundtables', '/inbox'], placement: 'dock', area: 'roundtable', sections: [
      { key: 'roundtables', to: '/roundtables', owns: ['/roundtables'] },
      { key: 'askedYou', to: '/inbox', owns: ['/inbox'] },
    ] },
    { key: 'memory', icon: 'memory', to: knowledge, owns: ['/knowledge', '/preferences', '/organize', '/tags'], placement: 'dock', sections: [
      { key: 'knowledge', to: knowledge, owns: ['/knowledge'] },
      { key: 'preferences', to: '/preferences', owns: ['/preferences'] },
      { key: 'organize', to: '/organize', owns: ['/organize'], area: 'tidy' },
      { key: 'tags', to: '/tags', owns: ['/tags'] },
    ] },
    { key: 'projects', icon: 'project', to: projects, owns: ['/personal/'], placement: 'dock', sections: [
      { key: 'myProjects', to: projects, owns: ['/personal/'] },
    ] },
    { key: 'settings', icon: 'settings', to: '/settings', owns: ['/settings', '/about', '/howto'], placement: 'top', sections: [
      { key: 'settings', to: '/settings', owns: ['/settings'] },
      { key: 'about', to: '/about', owns: ['/about'] },
      { key: 'howto', to: '/howto', owns: ['/howto'] },
    ] },
  ]
}

function owns(prefixes: readonly string[], path: string, exact = false): boolean {
  return prefixes.some(prefix => exact || prefix === '/' ? path === prefix : path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
}

export function activeDestination(destinations: readonly NavDestination[], path: string): NavDestination | undefined {
  return destinations.find(destination => owns(destination.owns, path, destination.exact))
}

// The longest owning prefix wins, so /project-agents/manage selects 编排, not 全部.
export function activeSection(destination: NavDestination | undefined, path: string): NavSection | undefined {
  return destination?.sections
    .filter(section => owns(section.owns, path))
    .sort((a, b) => Math.max(...b.owns.map(o => o.length)) - Math.max(...a.owns.map(o => o.length)))[0]
}
