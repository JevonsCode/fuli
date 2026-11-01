<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { t } from '@/i18n'
import { personalProjectsPath } from '@/router/paths'
import { useConsoleStore } from '@/stores/console'
import type { PersonalProject } from '@/types'
import CreateProjectDialog from './CreateProjectDialog.vue'

// A visible, manual way to start a project; the new project opens on its overview.
const props = defineProps<{ spaceId: string }>()
const store = useConsoleStore()
const router = useRouter()
const open = ref(false)
const existingProjectIds = computed(() => (store.state?.personalProjects ?? [])
  .filter(project => project.personal_space_id === props.spaceId)
  .map(project => project.project_id))

async function created(project: PersonalProject) {
  open.value = false
  await store.refresh()
  await router.push(personalProjectsPath(props.spaceId, 'overview', project.project_id))
}
</script>

<template>
  <Button variant="ghost" data-create-project @click="open = true">＋ {{ t('projects.createDialog.open') }}</Button>
  <CreateProjectDialog :open="open" :personal-space-id="spaceId" :existing-project-ids="existingProjectIds" @close="open = false" @created="created" />
</template>
