<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import {
  projectRelationTierLabel,
  type FrequentProjectSummary,
} from '@/features/knowledge/project-relation-weights'
import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import type { PersonalProject } from '@/types'
import ProjectTeamSummary from './ProjectTeamSummary.vue'
import ProjectCaptureSwitch from '@/features/capture/ProjectCaptureSwitch.vue'

const props = withDefaults(defineProps<{
  spaceId: string
  project: PersonalProject
  frequentProjects?: readonly FrequentProjectSummary[]
  canPublish?: boolean
}>(), {
  frequentProjects: () => [],
  canPublish: false,
})

defineEmits<{ 'edit-profile': []; publish: [] }>()

const visibleFrequentProjects = computed(() =>
  (props.frequentProjects ?? []).slice(0, 3),
)
</script>

<template>
  <div class="project-overview">
    <header class="project-overview-header">
      <div class="project-overview-title">
        <h2>{{ project.profile.name }}</h2>
        <p v-if="project.profile.purpose" class="project-overview-purpose">{{ project.profile.purpose }}</p>
        <p v-else class="ui-meta">{{ t('projects.overview.noPurpose') }}</p>
      </div>
      <div class="project-overview-actions">
        <Button size="sm" variant="ghost" v-if="canPublish" @click="$emit('publish')">
          {{ t('knowledge.workspace.workspace.view.publishProject') }}
        </Button>
        <Button size="icon-sm" variant="ghost"
          :aria-label="t('projects.overview.editProfile')"
          :title="t('projects.overview.editProfile')"
          @click="$emit('edit-profile')"
        >
          <svg class="project-team-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></svg>
        </Button>
      </div>
    </header>
    <ProjectCaptureSwitch :key="project.project_id" class="project-capture-card" :project-id="project.project_id" :project-name="project.profile.name" />
    <ProjectTeamSummary :space-id="spaceId" :project-id="project.project_id" />
    <section
      class="project-frequent-projects"
      data-frequent-projects
      :aria-label="t('projects.overview.frequentProjects')"
    >
      <header class="project-frequent-header">
        <h3>{{ t('projects.overview.frequentProjects') }}</h3>
        <span class="ui-meta">{{ t('projects.overview.frequentProjectsHint') }}</span>
      </header>
      <p
        v-if="!visibleFrequentProjects.length"
        class="ui-meta"
        data-frequent-projects-empty
      >
        {{ t('projects.overview.noFrequentProjects') }}
      </p>
      <ul v-else class="project-frequent-list">
        <li
          v-for="item in visibleFrequentProjects"
          :key="item.projectId"
          class="project-frequent-item"
          :data-frequent-project="item.projectId"
          :data-weight-tier="item.tier"
        >
          <div class="project-frequent-main">
            <RouterLink
              class="project-frequent-link"
              :to="personalProjectsPath(spaceId, 'overview', item.projectId)"
            >
              {{ item.name }}
            </RouterLink>
            <span class="project-frequent-tier" :class="`is-${item.tier}`">
              {{ projectRelationTierLabel(item.tier) }}
            </span>
            <span class="ui-meta project-frequent-counts">
              {{ t('projects.overview.frequentProjectCounts', {
                recent: item.recent30dCount,
                total: item.totalCount,
              }) }}
            </span>
          </div>
          <p
            v-if="item.suggestKnowledgeReuse"
            class="project-frequent-reuse-hint"
            data-suggest-knowledge-reuse
          >
            {{ t('projects.overview.suggestKnowledgeReuse') }}
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
