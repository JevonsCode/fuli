<script setup lang="ts">
import { computed } from 'vue'

import KnowledgeWorkspace from '@/features/knowledge/KnowledgeWorkspace.vue'
import ProjectHistoryPreview from '@/features/project-history/ProjectHistoryPreview.vue'
import { useConsoleStore } from '@/stores/console'

const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
</script>

<template>
  <KnowledgeWorkspace personal-projects-only />
  <ProjectHistoryPreview v-if="spaceId" :space-id="spaceId" />
</template>
