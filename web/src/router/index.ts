import { createRouter, createWebHistory } from 'vue-router'

import { updateDocumentTitle } from './meta'
import { installNavigationRecovery } from './navigation-recovery'

export function legacyKnowledgeHashPath(hash: string) {
  const match = hash.match(
    /^#\/knowledge\/([^/?#]+)\/([^/?#]+)\/(entity|relationship)\/([^/?#]+)(?:\?([^#]*))?$/,
  )
  if (!match) return null
  const [, scope, spaceId, itemKind, itemId, query] = match
  return `/knowledge/${scope}/${spaceId}/directory/${itemKind}/${itemId}${
    query ? `?${query}` : ''
  }`
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/reports/jefa', name: 'shared-jefa-report', component: () => import('@/pages/SharedJefaReportPage.vue'), meta: { publicReport: true, title: 'employees.share.title' } },
    { path: '/roundtables/chat/:chatId', name: 'roundtable-chat', component: () => import('@/features/roundtables/RoundtablesPage.vue'), meta: { title: 'routes.roundtable.title', layout: 'canvas' } },
    { path: '/roundtables/:threadId?', name: 'roundtables', component: () => import('@/features/roundtables/RoundtablesPage.vue'), meta: { title: 'routes.roundtable.title', layout: 'canvas' } },
    {
      path: '/',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
      meta: { title: 'routes.overview.title', layout: 'canvas' },
    },
    {
      path: '/preferences',
      name: 'personal-profile',
      component: () => import('@/pages/PersonalProfilePage.vue'),
      meta: { title: 'routes.preferences.title', layout: 'canvas' },
    },
    {
      path: '/preferences/writing',
      name: 'writing-taste',
      component: () => import('@/pages/WritingTastePage.vue'),
      meta: { title: 'routes.writingTaste.title', layout: 'canvas' },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
      name: 'personal-project-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
        layout: 'canvas',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode/:itemKind/:itemId',
      name: 'personal-projects-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
        layout: 'canvas',
        description: 'routes.personalProjects.description',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode',
      name: 'personal-projects',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
        layout: 'canvas',
        description: 'routes.personalProjects.description',
      },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode',
      name: 'personal-project',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
        layout: 'canvas',
      },
    },
    {
      path: '/organize',
      name: 'knowledge-organizer',
      component: () => import('@/pages/KnowledgeOrganizerPage.vue'),
      meta: { title: 'routes.organizer.title', layout: 'canvas' },
    },
    {
      path: '/project-agents',
      name: 'project-agents',
      component: () => import('@/pages/AgentsDirectoryPage.vue'),
      meta: { title: 'routes.projectAgents.title', layout: 'canvas' },
    },
    { path: '/agents/:spaceId/:agentId', name: 'agent-profile', component: () => import('@/pages/AgentProfilePage.vue'), meta: { title: 'agentProfiles.profile', layout: 'canvas', detail: true } },
    { path: '/project-agents/occupations', name: 'occupations', component: () => import('@/pages/OccupationsPage.vue'), meta: { title: 'occupations.title', layout: 'canvas' } },
    { path: '/project-agents/schedules', name: 'task-schedules', component: () => import('@/pages/TaskSchedulesPage.vue'), meta: { title: 'taskSchedules.title', layout: 'canvas' } },
    { path: '/project-agents/manage', name: 'agent-management', component: () => import('@/pages/ProjectAgentsPage.vue'), meta: { title: 'shell.sections.orchestrate', layout: 'canvas' } },
    { path: '/project-agents/manage/:spaceId/:agentId', name: 'agent-management-detail', component: () => import('@/pages/ProjectAgentDetailPage.vue'), meta: { title: 'projectAgents.pageTitle', layout: 'canvas', detail: true } },
    {
      path: '/employees/:templateId',
      name: 'employee-workbench',
      component: () => import('@/pages/EmployeeWorkbenchPage.vue'),
      meta: { title: 'routes.employeeWorkbench.title', layout: 'canvas', detail: true },
    },
    {
      path: '/public-projects',
      name: 'public-projects',
      component: () => import('@/pages/PublicProjectsPage.vue'),
      meta: {
        title: 'routes.publicProjects.title',
        description: 'routes.publicProjects.description',
        layout: 'canvas',
      },
    },
    {
      path: '/knowledge',
      name: 'knowledge-default',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', layout: 'canvas' },
    },
    // rec#20: a turn receipt's links. Static segments outrank the knowledge
    // workspace's parameters, so these never open a workspace view.
    {
      path: '/knowledge/item/:spaceId/:itemKind(entity|relationship)/:itemId',
      name: 'knowledge-item-edit',
      component: () => import('@/pages/KnowledgeItemEditPage.vue'),
      meta: { title: 'routes.knowledgeItem.title', layout: 'form', detail: true },
    },
    {
      // rec#5 C6: one host session's records in the active space, short
      // because every saving turn's receipt links it. ?client= names the
      // client when two share a session ID; a record opens as ?item=<space>/<key>.
      path: '/s/:sessionId',
      name: 'session-records',
      component: () => import('@/pages/SessionRecordsPage.vue'),
      meta: { title: 'routes.sessionRecords.title', layout: 'canvas', detail: true },
    },
    {
      // rec#20 part 2: an Agent's link to move what the session held in its
      // temporary project into the formal project it linked to; the person
      // chooses the items. ?client= and ?project= name the session's client
      // and the target.
      path: '/s/:sessionId/migrate',
      name: 'session-migration',
      component: () => import('@/features/session-migration/SessionMigrationPage.vue'),
      meta: { title: 'routes.sessionMigration.title', layout: 'form', detail: true },
    },
    {
      // rec#11 D-07 part 2: the tag vocabulary, its review queue and the
      // person's governance. An Agent's link opens one tag's change:
      // ?tag=<id>&change=<approve|merge|split|retire|undo>[&into=<id>].
      path: '/tags',
      name: 'tags',
      component: () => import('@/features/knowledge-tags/TagVocabularyPage.vue'),
      meta: { title: 'routes.tags.title', layout: 'canvas' },
    },
    {
      path: '/knowledge/turn/:spaceId',
      name: 'knowledge-turn-receipt',
      component: () => import('@/pages/KnowledgeTurnReceiptPage.vue'),
      meta: { title: 'routes.knowledgeTurn.title', layout: 'form', detail: true },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode/:itemKind/:itemId',
      name: 'project-knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', layout: 'canvas' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode/:itemKind/:itemId',
      name: 'knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', layout: 'canvas' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode',
      name: 'project-knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', layout: 'canvas' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode',
      name: 'knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', layout: 'canvas' },
    },
    {
      path: '/inbox',
      name: 'inbox',
      component: () => import('@/pages/InboxPage.vue'),
      meta: {
        title: 'attention.title',
        layout: 'canvas',
      },
    },
    { path: '/review', redirect: '/public-projects' },
    {
      path: '/connections',
      name: 'connections',
      component: () => import('@/pages/ConnectionsPage.vue'),
      meta: {
        title: 'routes.connections.title',
        description: 'routes.connections.description',
        layout: 'form',
      },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/SettingsPage.vue'),
      meta: {
        title: 'routes.settings.title',
        layout: 'form',
        saveBar: true,
      },
    },
    {
      path: '/settings/models',
      name: 'model-settings',
      component: () => import('@/pages/ModelSettingsPage.vue'),
      meta: {
        title: 'modelSettings.title',
        // rec#38: one centred column of grouped lists, like the other settings pages.
        layout: 'form',
        detail: true,
      },
    },
    {
      path: '/settings/data-format',
      name: 'data-format',
      component: () => import('@/pages/DataFormatPage.vue'),
      meta: {
        title: 'dataFormat.title',
        layout: 'form',
        detail: true,
      },
    },
    {
      // An Agent's link to confirm a capture change it asked for (rec#5 C4-2, rec#11 D-16).
      path: '/capture-change/:previewId',
      name: 'capture-change',
      component: () => import('@/features/capture/CaptureChangePage.vue'),
      meta: { title: 'capture.confirm.title', layout: 'form', detail: true },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/pages/AboutPage.vue'),
      meta: {
        title: 'routes.about.title',
        layout: 'form',
      },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/pages/NotFoundPage.vue'),
      meta: { title: 'common.errors.pageNotFound', layout: 'form' },
    },
  ],
  scrollBehavior: (to, from, savedPosition) => savedPosition
    ?? (to.path === from.path ? false : { top: 0 }),
})

installNavigationRecovery(router)

router.beforeEach((to) => {
  if (to.path !== '/' || typeof window === 'undefined') return true
  const legacyPath = legacyKnowledgeHashPath(window.location.hash)
  return legacyPath ?? true
})

router.afterEach((route) => {
  updateDocumentTitle(route.meta.title)
})
