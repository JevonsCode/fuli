<script setup lang="ts">
import type { KnowledgeItem, PersonalProject } from '@/types'
import KnowledgeProjectDialog from '@/features/projects/KnowledgeProjectDialog.vue'
import PersonalProjectProfileDialog from '@/features/projects/PersonalProjectProfileDialog.vue'
import KnowledgeEditDialog from './KnowledgeEditDialog.vue'

defineProps<{
  editingItem: KnowledgeItem | null
  projectActionItem: KnowledgeItem | null
  managingProject: PersonalProject | null
  managingMaterialType: string | null
  personalSpaceId: string
  editingProjectId: string | null
  currentProjectId: string | null
  projects: PersonalProject[]
  replacementItems: KnowledgeItem[]
}>()

const emit = defineEmits<{
  'close-edit': []
  'close-project-action': []
  'close-profile': []
  'refresh': []
  'access-denied': []
  'project-saved': [result: { status: string }, targetName: string]
  'profile-saved': [project: PersonalProject]
}>()

function projectSaved(result: { status: string }, targetName: string) {
  emit('project-saved', result, targetName)
}

function profileSaved(project: PersonalProject) {
  emit('profile-saved', project)
}
</script>

<template>
  <KnowledgeEditDialog
    :item="editingItem"
    :personal-space-id="personalSpaceId"
    :personal-project-id="editingProjectId"
    :projects="projects"
    :replacement-items="replacementItems"
    @close="emit('close-edit')"
    @saved="emit('refresh')"
    @reload="emit('refresh')"
    @access-denied="emit('access-denied')"
  />
  <KnowledgeProjectDialog
    :item="projectActionItem"
    :personal-space-id="personalSpaceId"
    :personal-project-id="currentProjectId"
    :projects="projects"
    @close="emit('close-project-action')"
    @saved="projectSaved"
  />
  <PersonalProjectProfileDialog
    :project="managingProject"
    :material-type="managingMaterialType"
    @close="emit('close-profile')"
    @saved="profileSaved"
  />
</template>
