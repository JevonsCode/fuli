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
    {
      path: '/',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
      meta: { eyebrow: '', title: 'routes.overview.title' },
    },
    {
      path: '/preferences',
      name: 'personal-profile',
      component: () => import('@/pages/PersonalProfilePage.vue'),
      meta: {
        eyebrow: 'PERSONAL LENS',
        title: 'routes.preferences.title',
        description: 'routes.preferences.description',
      },
    },
    {
      path: '/preferences/writing',
      name: 'writing-taste',
      component: () => import('@/pages/WritingTastePage.vue'),
      meta: { eyebrow: '', title: 'routes.writingTaste.title' },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
      name: 'personal-project-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECT',
        title: 'routes.personalProjects.title',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode/:itemKind/:itemId',
      name: 'personal-projects-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECTS',
        title: 'routes.personalProjects.title',
        description: 'routes.personalProjects.description',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode',
      name: 'personal-projects',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECTS',
        title: 'routes.personalProjects.title',
        description: 'routes.personalProjects.description',
      },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode',
      name: 'personal-project',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECT',
        title: 'routes.personalProjects.title',
      },
    },
    {
      path: '/organize',
      name: 'knowledge-organizer',
      component: () => import('@/pages/KnowledgeOrganizerPage.vue'),
      meta: {
        eyebrow: 'KNOWLEDGE CLASSIFICATION',
        title: 'routes.organizer.title',
      },
    },
    {
      path: '/project-agents',
      name: 'project-agents',
      component: () => import('@/pages/ProjectAgentsPage.vue'),
      meta: { eyebrow: '', title: 'routes.projectAgents.title' },
    },
    {
      path: '/employees/:templateId',
      name: 'employee-workbench',
      component: () => import('@/pages/EmployeeWorkbenchPage.vue'),
      meta: { eyebrow: '', title: 'routes.employeeWorkbench.title', dedicatedWorkspace: true },
    },
    {
      path: '/public-projects',
      name: 'public-projects',
      component: () => import('@/pages/PublicProjectsPage.vue'),
      meta: {
        eyebrow: 'PUBLIC PROJECTS',
        title: 'routes.publicProjects.title',
        description: 'routes.publicProjects.description',
      },
    },
    {
      path: '/knowledge',
      name: 'knowledge-default',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: 'routes.knowledge.title' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode/:itemKind/:itemId',
      name: 'project-knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: 'routes.knowledge.title' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode/:itemKind/:itemId',
      name: 'knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: 'routes.knowledge.title' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode',
      name: 'project-knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: 'routes.knowledge.title' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode',
      name: 'knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: 'routes.knowledge.title' },
    },
    {
      path: '/review',
      name: 'review',
      component: () => import('@/pages/ReviewPage.vue'),
      meta: {
        eyebrow: 'REVIEW WORKSPACE',
        title: 'routes.review.title',
        description: 'routes.review.description',
      },
    },
    {
      path: '/connections',
      name: 'connections',
      component: () => import('@/pages/ConnectionsPage.vue'),
      meta: {
        eyebrow: 'SERVICE CONNECTIONS',
        title: 'routes.connections.title',
        description: 'routes.connections.description',
      },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/SettingsPage.vue'),
      meta: {
        eyebrow: '',
        title: 'routes.settings.title',
      },
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('@/pages/AboutPage.vue'),
      meta: {
        eyebrow: 'FULI',
        title: 'routes.about.title',
      },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
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
