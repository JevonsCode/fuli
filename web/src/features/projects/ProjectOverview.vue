<script setup lang="ts">
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import ProjectTeamSummary from './ProjectTeamSummary.vue'

defineProps<{ spaceId: string; project: PersonalProject; canPublish?: boolean }>()
defineEmits<{ 'edit-profile': []; publish: [] }>()
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
        <button v-if="canPublish" class="toolbar-action" type="button" @click="$emit('publish')">
          {{ t('knowledge.workspace.workspace.view.publishProject') }}
        </button>
        <button
          class="toolbar-action ui-button--icon"
          type="button"
          :aria-label="t('projects.overview.editProfile')"
          :title="t('projects.overview.editProfile')"
          @click="$emit('edit-profile')"
        >
          <svg class="project-team-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /></svg>
        </button>
      </div>
    </header>
    <ProjectTeamSummary :space-id="spaceId" :project-id="project.project_id" />
  </div>
</template>
