import { createRouter, createWebHistory } from 'vue-router'

import { legacyRouteFromUrl } from './legacy'

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
      meta: { eyebrow: 'LOCAL + FEDERATED', title: '概览' },
    },
    {
      path: '/preferences',
      name: 'personal-profile',
      component: () => import('@/pages/PersonalProfilePage.vue'),
      meta: {
        eyebrow: 'PERSONAL LENS',
        title: '协作偏好',
        description: '个人全局与项目级的品味、个性和判断偏好，只保存在本机。',
      },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode/:itemKind/:itemId',
      name: 'personal-project-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECT',
        title: '个人项目',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode/:itemKind/:itemId',
      name: 'personal-projects-item',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECTS',
        title: '个人项目',
        description: '本机私有项目、项目知识与按任务生效的协作偏好。',
      },
    },
    {
      path: '/personal/:spaceId/projects/:mode',
      name: 'personal-projects',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECTS',
        title: '个人项目',
        description: '本机私有项目、项目知识与按任务生效的协作偏好。',
      },
    },
    {
      path: '/personal/:spaceId/projects/:projectId/:mode',
      name: 'personal-project',
      component: () => import('@/pages/PersonalProjectsPage.vue'),
      meta: {
        eyebrow: 'PERSONAL PROJECT',
        title: '个人项目',
      },
    },
    {
      path: '/organize',
      name: 'knowledge-organizer',
      component: () => import('@/pages/KnowledgeOrganizerPage.vue'),
      meta: {
        eyebrow: 'KNOWLEDGE CLASSIFICATION',
        title: '知识整理',
        description: '按发现时四象限、确认依据与确认状态整理个人空间里的全部知识。',
      },
    },
    {
      path: '/public-projects',
      name: 'public-projects',
      component: () => import('@/pages/PublicProjectsPage.vue'),
      meta: {
        eyebrow: 'PUBLIC PROJECTS',
        title: '公共项目',
        description: '发现、订阅和维护公共 Provider 上的项目。',
      },
    },
    {
      path: '/knowledge',
      name: 'knowledge-default',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: '知识库' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode/:itemKind/:itemId',
      name: 'project-knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: '知识库' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode/:itemKind/:itemId',
      name: 'knowledge-item',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: '知识库' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:projectId/:mode',
      name: 'project-knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: '知识库' },
    },
    {
      path: '/knowledge/:scope/:spaceId/:mode',
      name: 'knowledge',
      component: () => import('@/pages/KnowledgePage.vue'),
      meta: { eyebrow: 'KNOWLEDGE BASE', title: '知识库' },
    },
    {
      path: '/review',
      name: 'review',
      component: () => import('@/pages/ReviewPage.vue'),
      meta: {
        eyebrow: 'REVIEW WORKSPACE',
        title: '发布审核',
        description: '个人发布确认与公共项目 Maintainer 审核。',
      },
    },
    {
      path: '/connections',
      name: 'connections',
      component: () => import('@/pages/ConnectionsPage.vue'),
      meta: {
        eyebrow: 'SERVICE CONNECTIONS',
        title: '服务连接',
        description: '本地知识库状态、公共 Provider 与项目订阅。',
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
  const title = String(route.meta.title ?? 'Context Graph')
  document.title = `${title} · 复利`
})
