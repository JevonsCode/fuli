<script setup lang="ts">
import { RouterLink } from 'vue-router'

import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import type { ParentProject } from './project-hierarchy'

const props = defineProps<{
  parents: ParentProject[]
  activeProjectName?: string | null
  spaceId: string
}>()

function currentProjectName() {
  return props.activeProjectName || t('knowledge.workspace.hierarchy.currentProject')
}
</script>

<template>
  <aside
    v-if="parents.length"
    class="project-hierarchy-aside"
    :aria-label="t('knowledge.workspace.hierarchy.aria')"
  >
    <header>
      <span>{{ t('knowledge.workspace.hierarchy.level') }}</span>
      <strong>{{ t('knowledge.workspace.hierarchy.parents') }}</strong>
      <small>{{ t('common.counts.projects', { count: parents.length }) }}</small>
    </header>
    <p>
      {{ t('knowledge.workspace.hierarchy.belongsTo', { name: currentProjectName() }) }}
    </p>
    <nav :aria-label="t('knowledge.workspace.hierarchy.listAria')">
      <RouterLink
        v-for="parent in parents"
        :key="parent.nodeId"
        class="project-parent-link"
        :to="personalProjectsPath(spaceId, 'graph', parent.projectId)"
        :aria-label="t('knowledge.workspace.hierarchy.openParent', { name: parent.name })"
      >
        <span class="project-parent-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3 6h7l2 2h9v11H3zM12 16V9M9 12l3-3 3 3" />
          </svg>
        </span>
        <span>
          <small>{{ t('knowledge.workspace.hierarchy.parents') }}</small>
          <strong>{{ parent.name }}</strong>
          <em>{{ t('knowledge.workspace.hierarchy.belongsToParent', { name: currentProjectName() }) }}</em>
        </span>
        <b aria-hidden="true">→</b>
      </RouterLink>
    </nav>
  </aside>
</template>
