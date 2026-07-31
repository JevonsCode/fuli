import { createRouter, createWebHistory } from 'vue-router'

import { legacyRouteFromUrl } from './legacy'
import { updateDocumentTitle } from './meta'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
      meta: { eyebrow: 'LOCAL + FEDERATED', title: 'routes.overview.title' },
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
        description: 'routes.organizer.description',
      },
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
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

let migratedInitialLocation = false
router.beforeEach(() => {
  if (migratedInitialLocation || typeof window === 'undefined') return true
  migratedInitialLocation = true
  return legacyRouteFromUrl(new URL(window.location.href)) ?? true
})

router.afterEach((route) => {
  updateDocumentTitle(route.meta.title)
})
