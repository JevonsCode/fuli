import { shallowMount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { KnowledgeItem, PersonalProject } from '@/types'
import KnowledgeProjectDialog from '@/features/projects/KnowledgeProjectDialog.vue'
import PersonalProjectProfileDialog from '@/features/projects/PersonalProjectProfileDialog.vue'
import PublishProjectDialog from '@/features/projects/PublishProjectDialog.vue'
import KnowledgeConfirmDialog from './KnowledgeConfirmDialog.vue'
import KnowledgeEditDialog from './KnowledgeEditDialog.vue'
import KnowledgeWorkspaceDialogs from './KnowledgeWorkspaceDialogs.vue'

const item = {
  id: 'knowledge-fixture',
  itemKind: 'entity',
  title: 'Fixture',
} as KnowledgeItem

const project = {
  personal_space_id: 'space-fixture',
  project_id: 'project-fixture',
  profile: { name: 'Fixture project' },
} as PersonalProject

describe('KnowledgeWorkspaceDialogs', () => {
  it('forwards dialog props and lifecycle events to the workspace', async () => {
    const wrapper = shallowMount(KnowledgeWorkspaceDialogs, {
      props: {
        editingItem: item,
        confirmingItem: item,
        projectActionItem: item,
        publishingProject: project,
        managingProject: project,
        managingMaterialType: 'ProjectPurpose',
        personalSpaceId: 'space-fixture',
        editingProjectId: 'edit-project',
        confirmingProjectId: null,
        currentProjectId: 'project-fixture',
        projects: [project],
        replacementItems: [item],
      },
    })

    const editDialog = wrapper.findComponent(KnowledgeEditDialog)
    const confirmDialog = wrapper.findComponent(KnowledgeConfirmDialog)
    const projectDialog = wrapper.findComponent(KnowledgeProjectDialog)
    const publishDialog = wrapper.findComponent(PublishProjectDialog)
    const profileDialog = wrapper.findComponent(PersonalProjectProfileDialog)

    expect(editDialog.props('personalProjectId')).toBe('edit-project')
    expect(editDialog.props('replacementItems')).toEqual([item])
    expect(confirmDialog.props('personalProjectId')).toBeNull()
    expect(projectDialog.props('projects')).toEqual([project])
    expect(profileDialog.props('materialType')).toBe('ProjectPurpose')

    editDialog.vm.$emit('close')
    confirmDialog.vm.$emit('saved')
    projectDialog.vm.$emit('saved', { status: 'linked' }, 'Target project')
    publishDialog.vm.$emit('published')
    profileDialog.vm.$emit('saved', project)
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close-edit')).toHaveLength(1)
    expect(wrapper.emitted('refresh')).toHaveLength(2)
    expect(wrapper.emitted('project-saved')).toEqual([
      [{ status: 'linked' }, 'Target project'],
    ])
    expect(wrapper.emitted('profile-saved')).toEqual([[project]])
  })
})
