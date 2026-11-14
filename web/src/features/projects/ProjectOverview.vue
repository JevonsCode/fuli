<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import {
  projectRelationTierLabel,
  type FrequentProjectSummary,
} from '@/features/knowledge/project-relation-weights'
import { currentLocale, t } from '@/i18n'
import { DATE_ONLY, formatDateTime } from '@/lib/date-time'
import { personalProjectsPath } from '@/router/paths'
import type { PersonalProject } from '@/types'
import ProjectBoardSettings from './ProjectBoardSettings.vue'
import ProjectChangeLog from './ProjectChangeLog.vue'
import ProjectOrganizing from './ProjectOrganizing.vue'
import ProjectTeamSummary from './ProjectTeamSummary.vue'
import ProfileAuthorChip from './ProfileAuthorChip.vue'
import ProjectCaptureSwitch from '@/features/capture/ProjectCaptureSwitch.vue'
import GuestLinksCard from '@/features/guest-links/GuestLinksCard.vue'
import ProjectJudgmentPolicy from '@/features/judgment/ProjectJudgmentPolicy.vue'

const props = withDefaults(defineProps<{
  spaceId: string
  project: PersonalProject
  frequentProjects?: readonly FrequentProjectSummary[]
}>(), {
  frequentProjects: () => [],
})

defineEmits<{ 'edit-profile': [] }>()

const visibleFrequentProjects = computed(() =>
  (props.frequentProjects ?? []).slice(0, 3),
)
const createdDate = computed(() =>
  formatDateTime(props.project.created_at, currentLocale(), DATE_ONLY, { missing: '' }),
)
</script>

<template>
  <div class="project-overview">
    <header class="project-overview-header">
      <div class="project-overview-title">
        <h2>{{ project.profile.name }}</h2>
        <p v-if="createdDate" class="ui-meta" data-project-created>{{ t('projects.overview.createdAt', { date: createdDate }) }}</p>
        <p v-if="project.profile.purpose" class="project-overview-purpose">{{ project.profile.purpose }}</p>
        <ProfileAuthorChip v-if="project.profile.purpose" class="project-overview-author" :author="project.profile.authors?.purpose" />
        <p v-else class="ui-meta">{{ t('projects.overview.noPurpose') }}</p>
      </div>
      <div class="project-overview-actions">
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
    <ProjectJudgmentPolicy :key="`judgment-${project.project_id}`" class="project-judgment-card" :personal-space-id="spaceId"
      :project-id="project.project_id" :project-name="project.profile.name" :heading="t('judgment.project.heading')">
      <template #heading-action>
        <RouterLink class="project-judgment-default-link" to="/employees/tonborg?view=standards" data-judgment-default-link>
          {{ t('judgment.project.defaultLink') }}
        </RouterLink>
      </template>
    </ProjectJudgmentPolicy>
    <ProjectOrganizing :key="`organizing-${project.project_id}`" class="project-organizing-card" :space-id="spaceId" :project-id="project.project_id" />
    <ProjectTeamSummary :space-id="spaceId" :project-id="project.project_id" />
    <ProjectBoardSettings :key="`board-${project.project_id}`" :space-id="spaceId" :project-id="project.project_id" :project-name="project.profile.name" />
    <GuestLinksCard :key="`guests-${project.project_id}`" :project-id="project.project_id" />
    <ProjectChangeLog :key="`changes-${project.project_id}`" :space-id="spaceId" :project-id="project.project_id"
      :project-name="project.profile.name" :updated-at="project.updated_at" />
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
