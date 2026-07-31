<script setup lang="ts">
import type { KnowledgeItem, PersonalProject } from '@/types'
import KnowledgeProjectDialog from '@/features/projects/KnowledgeProjectDialog.vue'
import PersonalProjectProfileDialog from '@/features/projects/PersonalProjectProfileDialog.vue'
import PublishProjectDialog from '@/features/projects/PublishProjectDialog.vue'
import KnowledgeConfirmDialog from './KnowledgeConfirmDialog.vue'
import KnowledgeEditDialog from './KnowledgeEditDialog.vue'

defineProps<{
  editingItem: KnowledgeItem | null
  confirmingItem: KnowledgeItem | null
  projectActionItem: KnowledgeItem | null
  publishingProject: PersonalProject | null
  managingProject: PersonalProject | null
  managingMaterialType: string | null
  personalSpaceId: string
  editingProjectId: string | null
  confirmingProjectId: string | null
  currentProjectId: string | null
  projects: PersonalProject[]
  replacementItems: KnowledgeItem[]
}>()

const emit = defineEmits<{
  'close-edit': []
  'close-confirm': []
  'close-project-action': []
  'close-publish': []
  'close-profile': []
  'refresh': []
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
  />
  <KnowledgeConfirmDialog
    :item="confirmingItem"
    :personal-space-id="personalSpaceId"
    :personal-project-id="confirmingProjectId"
    @close="emit('close-confirm')"
    @saved="emit('refresh')"
  />
  <KnowledgeProjectDialog
    :item="projectActionItem"
    :personal-space-id="personalSpaceId"
    :personal-project-id="currentProjectId"
    :projects="projects"
    @close="emit('close-project-action')"
    @saved="projectSaved"
  />
  <PublishProjectDialog
    :project="publishingProject"
    @close="emit('close-publish')"
    @published="emit('refresh')"
  />
  <PersonalProjectProfileDialog
    :project="managingProject"
    :material-type="managingMaterialType"
    @close="emit('close-profile')"
    @saved="profileSaved"
  />
</template>
