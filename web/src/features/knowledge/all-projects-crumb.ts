import { t } from '@/i18n'

// Inside one project, the way back to all projects: Back when the project was
// opened from the projects graph or directory, otherwise the projects graph.
const ALL_PROJECTS_PATH = /^\/personal\/[^/]+\/projects\/(graph|directory)(?:[?#]|$)/

export const allProjectsCrumb = (spaceId: string) => ({
  label: t('knowledge.workspace.projectPeek.allProjects'),
  to: `/personal/${spaceId}/projects/graph`,
  from: ALL_PROJECTS_PATH,
})
