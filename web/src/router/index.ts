import { createRouter, createWebHistory } from 'vue-router'

import { updateDocumentTitle } from './meta'
import { installNavigationRecovery } from './navigation-recovery'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/reports/jefa', name: 'shared-jefa-report', component: () => import('@/pages/SharedJefaReportPage.vue'), meta: { publicReport: true, title: 'employees.share.title' } },
    { path: '/roundtables/chat/:chatId', name: 'roundtable-chat', component: () => import('@/features/roundtables/RoundtablesPage.vue'), meta: { title: 'routes.roundtable.title' } },
    { path: '/roundtables/:threadId?', name: 'roundtables', component: () => import('@/features/roundtables/RoundtablesPage.vue'), meta: { title: 'routes.roundtable.title' } },
    {
      path: '/',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
      meta: { title: 'routes.overview.title' },
    },
    // The workbench's lists, each on its own page with search and filters in the query (Jevons 11-06).
    { path: '/workbench/:list(running|done|notices)', name: 'workbench-list', component: () => import('@/features/workbench-lists/WorkbenchListPage.vue'), meta: { title: 'routes.overview.title', detail: true } },
    {
      path: '/preferences',
      name: 'personal-profile',
      component: () => import('@/pages/PersonalProfilePage.vue'),
      meta: { title: 'routes.preferences.title' },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
      name: 'personal-project-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode/:itemKind/:itemId',
      name: 'personal-projects-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
        description: 'routes.personalProjects.description',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode',
      name: 'personal-projects',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
        description: 'routes.personalProjects.description',
      },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode',
      name: 'personal-project',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        title: 'routes.personalProjects.title',
      },
    },
    {
      path: '/organize',
      name: 'knowledge-organizer',
      component: () => import('@/pages/KnowledgeOrganizerPage.vue'),
      meta: { title: 'routes.organizer.title' },
    },
    {
      path: '/project-agents',
      name: 'project-agents',
      component: () => import('@/features/flas/FlasPage.vue'),
      meta: { title: 'routes.projectAgents.title', aiHelp: 'task.workbench' },
    },
    { path: '/agents/:spaceId/:agentId', name: 'agent-profile', component: () => import('@/pages/AgentProfilePage.vue'), meta: { title: 'agentProfiles.profile', detail: true } },
    { path: '/project-agents/occupations', name: 'occupations', component: () => import('@/pages/OccupationsPage.vue'), meta: { title: 'occupations.title' } },
    { path: '/project-agents/services', name: 'agent-services', component: () => import('@/pages/AgentServicesPage.vue'), meta: { title: 'agentServices.title' } },
    { path: '/project-agents/apps', name: 'agent-apps', component: () => import('@/features/agent-apps/AgentAppsPage.vue'), meta: { title: 'agentApps.title' } },
    { path: '/project-agents/apps/:appId', name: 'agent-app', component: () => import('@/features/agent-apps/AppViewerPage.vue'), meta: { title: 'agentApps.title', detail: true } },
    { path: '/project-agents/manage', name: 'agent-management', component: () => import('@/pages/ProjectAgentsPage.vue'), meta: { title: 'shell.sections.orchestrate' } },
    {
      path: '/employees/:templateId',
      name: 'employee-workbench',
      component: () => import('@/pages/EmployeeRedirectPage.vue'),
      meta: { title: 'routes.employeeWorkbench.title', detail: true },
    },
    {
      path: '/knowledge',
      name: 'knowledge-default',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', aiHelp: 'task.knowledge' },
    },
    // rec#20: a turn receipt's links. Static segments outrank the knowledge
    // workspace's parameters, so these never open a workspace view.
    {
      path: '/knowledge/item/:spaceId/:itemKind(entity|relationship)/:itemId',
      name: 'knowledge-item-edit',
      component: () => import('@/pages/KnowledgeItemEditPage.vue'),
      meta: { title: 'routes.knowledgeItem.title', detail: true },
    },
    {
      // rec#5 C6: one host session's records in the active space, short
      // because every saving turn's receipt links it. ?client= names the
      // client when two share a session ID; a record opens as ?item=<space>/<key>.
      path: '/s/:sessionId',
      name: 'session-records',
      component: () => import('@/pages/SessionRecordsPage.vue'),
      meta: { title: 'routes.sessionRecords.title', detail: true },
    },
    {
      // rec#20 part 2: an Agent's link to move what the session held in its
      // temporary project into the formal project it linked to; the person
      // chooses the items. ?client= and ?project= name the session's client
      // and the target.
      path: '/s/:sessionId/migrate',
      name: 'session-migration',
      component: () => import('@/features/session-migration/SessionMigrationPage.vue'),
      meta: { title: 'routes.sessionMigration.title', detail: true },
    },
    {
      // rec#11 D-07 part 2: the tag vocabulary, its review queue and the
      // person's governance. An Agent's link opens one tag's change:
      // ?tag=<id>&change=<approve|merge|split|retire|undo>[&into=<id>].
      path: '/tags',
      name: 'tags',
      component: () => import('@/features/knowledge-tags/TagVocabularyPage.vue'),
      meta: { title: 'routes.tags.title' },
    },
    {
      path: '/knowledge/turn/:spaceId',
      name: 'knowledge-turn-receipt',
      component: () => import('@/pages/KnowledgeTurnReceiptPage.vue'),
      meta: { title: 'routes.knowledgeTurn.title', detail: true },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode/:itemKind/:itemId',
      name: 'project-knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', aiHelp: 'task.knowledge' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode/:itemKind/:itemId',
      name: 'knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', aiHelp: 'task.knowledge' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode',
      name: 'project-knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', aiHelp: 'task.knowledge' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode',
      name: 'knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { title: 'routes.knowledge.title', aiHelp: 'task.knowledge' },
    },
    {
      path: '/inbox',
      name: 'inbox',
      component: () => import('@/pages/InboxPage.vue'),
      meta: {
        title: 'attention.title',
        aiHelp: 'task.decisions',
      },
    },
    {
      path: '/connections',
      name: 'connections',
      component: () => import('@/pages/ConnectionsPage.vue'),
      meta: {
        title: 'routes.connections.title',
        description: 'routes.connections.description',
        aiHelp: 'task.connections',
      },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/SettingsPage.vue'),
      meta: {
        title: 'routes.settings.title',
        saveBar: true,
      },
    },
    // Models are their own page beside 设置 (Jevons 11-06), reached from the model button.
    {
      path: '/models',
      name: 'model-settings',
      component: () => import('@/pages/ModelSettingsPage.vue'),
      meta: {
        title: 'modelSettings.title',
        aiHelp: 'task.models',
      },
    },
    { path: '/settings/models', redirect: '/models' },
    {
      path: '/settings/data-format',
      name: 'data-format',
      component: () => import('@/pages/DataFormatPage.vue'),
      meta: {
        title: 'dataFormat.title',
        detail: true,
      },
    },
    {
      path: '/debug',
      name: 'debug-turns',
      component: () => import('@/pages/DebugTurnsPage.vue'),
      meta: {
        title: 'debugTurns.title',
        detail: true,
      },
    },
    {
      path: '/debug/:id',
      name: 'debug-turn',
      component: () => import('@/pages/DebugTurnPage.vue'),
      meta: {
        title: 'debugTurns.title',
        detail: true,
      },
    },
    {
      // An Agent's link to confirm a capture change it asked for (rec#5 C4-2, rec#11 D-16).
      path: '/capture-change/:previewId',
      name: 'capture-change',
      component: () => import('@/features/capture/CaptureChangePage.vue'),
      meta: { title: 'capture.confirm.title', detail: true },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/pages/AboutPage.vue'),
      meta: {
        title: 'routes.about.title',
      },
    },
    {
      path: '/howto',
      name: 'howto',
      component: () => import('@/pages/HowtoPage.vue'),
      meta: {
        title: 'routes.howto.title',
      },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/pages/NotFoundPage.vue'),
      meta: { title: 'common.errors.pageNotFound' },
    },
  ],
  scrollBehavior: (to, from, savedPosition) => savedPosition
    ?? (to.path === from.path ? false : { top: 0 }),
})

installNavigationRecovery(router)

router.afterEach((route) => {
  updateDocumentTitle(route.meta.title)
})
