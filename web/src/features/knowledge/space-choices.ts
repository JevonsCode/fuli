import { computed, type ComputedRef } from 'vue'

import { isListedProject } from '@/features/projects/project-list-visibility'
import { projectScopeGroups, temporaryGroupLabel } from '@/features/projects/project-scope-choices'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeScope } from '@/router/paths'

export interface SpaceChoice {
  key: string
  scope: KnowledgeScope
  spaceId: string
  projectId: string | null
  providerUrl: string | null
  label: string
  /** A temporary project: its date and title as far as recorded, and the heading it folds under. */
  detail?: string
  group?: string
}

export function choiceKey(scope: KnowledgeScope, spaceId: string, projectId: string | null) {
  return JSON.stringify([scope, spaceId, projectId])
}

// The spaces and projects the graph toolbar offers: every personal space and
// its projects first, then the team-shared (public) projects when they apply.
// Temporary projects the list shows (the 临时项目 switch) fold under one heading,
// numbered over every personal space so two spaces never share a number.
export function useSpaceChoices(input: {
  personalProjectsOnly: boolean
  spaceId: ComputedRef<string>
  projectId: ComputedRef<string | null>
  scope: ComputedRef<KnowledgeScope>
  projectListingOptions: ComputedRef<{ showTemporary: boolean; selectedProjectId: string | null }>
}) {
  const store = useConsoleStore()

  const spaceChoices = computed<SpaceChoice[]>(() => {
    const state = store.state
    if (!state) return []
    const listed = (state.personalProjects ?? []).filter((project) => !input.personalProjectsOnly || isListedProject(project, {
      ...input.projectListingOptions.value,
      selectedProjectId: project.personal_space_id === input.spaceId.value ? input.projectId.value : null,
    }))
    const groups = projectScopeGroups(listed)
    const heading = temporaryGroupLabel()
    const personal = state.personalSpaces.flatMap((space) => {
      const aggregate: SpaceChoice = {
        key: choiceKey('personal', space.id, null),
        scope: 'personal',
        spaceId: space.id,
        projectId: null,
        providerUrl: null,
        label: t('knowledge.workspace.workspace.spaces.allPersonalProjects', {
          name: space.name,
        }),
      }
      const inSpace = <T extends { project: { personal_space_id: string } }>(choices: T[]) =>
        choices.filter((choice) => choice.project.personal_space_id === space.id)
      const formal = inSpace(groups.formal).map((choice): SpaceChoice => ({
        key: choiceKey('personal', space.id, choice.project.project_id),
        scope: 'personal',
        spaceId: space.id,
        projectId: choice.project.project_id,
        providerUrl: null,
        label: t('knowledge.workspace.workspace.spaces.personalProject', { name: choice.label }),
      }))
      const temporary = inSpace(groups.temporary).map((choice): SpaceChoice => ({
        key: choiceKey('personal', space.id, choice.project.project_id),
        scope: 'personal',
        spaceId: space.id,
        projectId: choice.project.project_id,
        providerUrl: null,
        label: choice.label,
        detail: choice.detail,
        group: heading,
      }))
      return [aggregate, ...formal, ...temporary]
    })
    if (input.personalProjectsOnly) return personal
    const publicProjects = state.projects.map((project): SpaceChoice => ({
      key: choiceKey('public', project.id, null),
      scope: 'public',
      spaceId: project.id,
      projectId: null,
      providerUrl: project.providerUrl,
      label: t('knowledge.workspace.workspace.spaces.publicProject', { name: project.name }),
    }))
    return [...personal, ...publicProjects]
  })

  const selectedChoiceKey = computed(() =>
    choiceKey(input.scope.value, input.spaceId.value, input.projectId.value))

  const spaceSelectOptions = computed(() =>
    spaceChoices.value.map((choice) => {
      const identity = choice.projectId ?? choice.spaceId
      return {
        value: choice.key,
        label: choice.label,
        meta: choice.detail || `#${compactIdentity(identity, 26)}`,
        search: identitySearchText(identity),
        ...(choice.group ? { group: choice.group } : {}),
      }
    }))

  return { spaceChoices, selectedChoiceKey, spaceSelectOptions }
}
