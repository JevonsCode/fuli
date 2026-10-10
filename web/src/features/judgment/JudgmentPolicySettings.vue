<script setup lang="ts">
import { computed } from 'vue'

import { useConsoleStore } from '@/stores/console'

import JudgmentPolicyPanel from './JudgmentPolicyPanel.vue'

const store = useConsoleStore()
const personalSpaceId = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => (store.state?.personalProjects ?? [])
  .filter(project => project.personal_space_id === personalSpaceId.value)
  .map(project => ({ id: project.project_id, name: project.profile.name })))
</script>

<template>
  <JudgmentPolicyPanel :personal-space-id="personalSpaceId" :projects="projects" />
</template>
