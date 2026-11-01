import { computed, type Ref } from 'vue'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { useAgentRecords } from '@/features/agent-profile/useAgentRecords'
import { projectDisplayName } from '@/features/projects/project-origin'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { TeamSheet } from './team-sheets'

/** Names for everyone holding a share and for the tasks' projects, read once for a set of sheets. */
export function useTeamPeople(spaceId: Ref<string>, sheets: Ref<TeamSheet[]>) {
  const store = useConsoleStore()
  const ids = computed(() => [...new Set(sheets.value.flatMap(sheet => sheet.shares.map(share => share.agentId)))])
  const people = useAgentRecords(spaceId, ids)
  const projects = computed(() => new Map((store.state?.personalProjects ?? []).map(project => [project.project_id, projectDisplayName(project)])))
  return {
    nameOf: (agentId: string) => {
      const record = people.records.value[agentId]
      return record ? agentDisplayName(record) : t('teamWork.card.unknownAgent')
    },
    projectName: (projectId: string) => projects.value.get(projectId) ?? projectId,
  }
}
