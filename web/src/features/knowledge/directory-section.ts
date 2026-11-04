import { watch, type Ref } from 'vue'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { isManagementKnowledgeItem } from './model'
import type { KnowledgeItem } from '@/types'

export type DirectorySection = 'knowledge' | 'materials'

/**
 * Which list the directory shows. Above any one project it opens on 全部项目
 * (Jevons 11-04); a project opens on its knowledge. An open item decides first.
 */
export function directorySectionFor(projectId: string | null | undefined, section: string, item: KnowledgeItem | null): DirectorySection {
  if (item) return isManagementKnowledgeItem(item) ? 'materials' : 'knowledge'
  if (!projectId) return section === 'knowledge' ? 'knowledge' : 'materials'
  return section === 'materials' ? 'materials' : 'knowledge'
}

/** 修改项目信息 on any project name (the right-click menu) lands here with ?edit=profile. */
export function useProfileEditLink(route: RouteLocationNormalizedLoaded, router: Router, project: Ref<unknown>, open: () => void) {
  watch([() => route.query.edit, project], ([edit, current]) => {
    if (edit !== 'profile' || !current) return
    open()
    const { edit: _edit, ...query } = route.query
    void router.replace({ query })
  }, { immediate: true })
}
