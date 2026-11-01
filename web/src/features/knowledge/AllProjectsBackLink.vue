<script setup lang="ts">
import BackLink from '@/components/BackLink.vue'
import { t } from '@/i18n'

// Inside one project, the way back to all projects: Back when the project was
// opened from the projects graph or directory, otherwise the projects graph.
defineProps<{ spaceId: string }>()
const ALL_PROJECTS_PATH = /^\/personal\/[^/]+\/projects\/(graph|directory)(?:[?#]|$)/
</script>

<template>
  <BackLink class="project-back" :to="`/personal/${spaceId}/projects/graph`" :from="ALL_PROJECTS_PATH" data-project-back>
    {{ t('knowledge.workspace.projectPeek.allProjects') }}
  </BackLink>
</template>

<style scoped>
.project-back { align-self: flex-start; color: var(--color-muted); font-size: 13px; text-decoration: none; }
.project-back:hover { color: var(--color-ink); }
</style>
