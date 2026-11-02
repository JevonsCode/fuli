import { computed, type ComputedRef } from 'vue'

import { isListedProject } from '@/features/projects/project-list-visibility'
import { pickerOrder, projectDisplayName } from '@/features/projects/project-origin'
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
}

export function choiceKey(scope: KnowledgeScope, spaceId: string, projectId: string | null) {
  return JSON.stringify([scope, spaceId, projectId])
}

// The spaces and projects the graph toolbar offers: every personal space and
// its projects first, then the team-shared (public) projects when they apply.
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
      const projects = pickerOrder((state.personalProjects ?? [])
        .filter((project) => project.personal_space_id === space.id
          && (!input.personalProjectsOnly || isListedProject(project, {
            ...input.projectListingOptions.value,
            selectedProjectId: space.id === input.spaceId.value ? input.projectId.value : null,
          }))))
        .map((project): SpaceChoice => ({
          key: choiceKey('personal', space.id, project.project_id),
          scope: 'personal',
          spaceId: space.id,
          projectId: project.project_id,
          providerUrl: null,
          label: t('knowledge.workspace.workspace.spaces.personalProject', {
            name: projectDisplayName(project),
          }),
        }))
      return [aggregate, ...projects]
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
        meta: `#${compactIdentity(identity, 26)}`,
        search: identitySearchText(identity),
      }
    }))

  return { spaceChoices, selectedChoiceKey, spaceSelectOptions }
}
