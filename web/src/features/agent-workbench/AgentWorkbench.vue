<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Card } from '@/components/ui/card'
import EmployeeTaskBoard, { type EmployeeBoardItem } from '@/features/employees/EmployeeTaskBoard.vue'
import type { ProjectBoardRecord } from '@/features/employees/project-board-layout'
import { agentManagementPath } from '@/features/project-agents/orchestration-filters'
import { readProjectBoard } from '@/features/projects/project-board-settings'
import { t } from '@/i18n'
import type { ProjectAgentTaskRecord } from '@/types'
import AgentWorkflowList from './AgentWorkflowList.vue'
import { agentTaskBoards } from './agent-task-board'
import type { AgentWorkflow } from './agent-workflows'

// An Agent's home tab (rec#60 D-78): its tasks on the shared task board and
// its own workflows. Loaded only while the tab is open; nothing here polls.
const props = defineProps<{
  personalSpaceId: string
  agentId: string
  tasks: ProjectAgentTaskRecord[]
  projectName: (projectId: string) => string
  workflows: AgentWorkflow[]
  /** Part of the Agent's tasks could not be read. */
  incomplete: boolean
}>()
const emit = defineEmits<{ 'workflows-changed': [] }>()
const router = useRouter()

const boards = computed(() => agentTaskBoards(props.tasks,
  (projectId) => projectId ? props.projectName(projectId) : t('agentProfiles.noProject')))
const projects = computed(() => boards.value.map((board) => board.project))
const visibleProjectIds = ref<string[]>([])
watch(() => projects.value.map((project) => project.id).join('\n'), () => {
  visibleProjectIds.value = projects.value.map((project) => project.id)
}, { immediate: true })

// One project on the board shows that project's own columns (Jefa's project
// board); several projects show the built-in five, each card naming its column.
// A project whose board cannot be read (Jefa not ready) keeps the built-in columns.
const projectBoards = ref(new Map<string, ProjectBoardRecord | null>())
const singleProjectId = computed(() => visibleProjectIds.value.length === 1 ? visibleProjectIds.value[0]! : '')
const readingProjectBoard = computed(() => Boolean(singleProjectId.value) && !projectBoards.value.has(singleProjectId.value))
watch(singleProjectId, async (projectId) => {
  if (!projectId || projectBoards.value.has(projectId)) return
  const setup = await readProjectBoard(props.personalSpaceId, projectId).catch(() => null)
  projectBoards.value = new Map(projectBoards.value).set(projectId, setup)
}, { immediate: true })
const visibleBoards = computed(() => {
  const visible = new Set(visibleProjectIds.value)
  return boards.value.filter((board) => visible.has(board.project.id)).map((board) => {
    const projectBoard = projectBoards.value.get(board.project.id)
    return projectBoard ? { ...board, projectBoard } : board
  })
})

function openTask(item: EmployeeBoardItem) {
  void router.push({ path: agentManagementPath(props.personalSpaceId, props.agentId), query: { task: item.id } })
}
</script>

<template>
  <div class="agent-workbench">
    <Card v-if="boards.length" as="section" class="agent-workbench-board" data-workbench-board>
      <GrowthLoading v-if="readingProjectBoard" variant="compact" :label="t('agentWorkbench.readingBoard')" />
      <EmployeeTaskBoard
        v-else
        v-model:visible-project-ids="visibleProjectIds"
        :boards="visibleBoards"
        :projects="projects"
        :failed-projects="0"
        :can-move-tasks="false"
        :incomplete="incomplete"
        @select-task="openTask"
      />
    </Card>
    <Card as="section" class="agent-resume-section">
      <AgentWorkflowList :workflows="workflows" @changed="emit('workflows-changed')" />
    </Card>
  </div>
</template>

<style scoped>
.agent-workbench { display: grid; gap: var(--space-4, 16px); min-width: 0; }
/* The board scrolls inside its columns, so a long column never stretches the page. */
.agent-workbench-board { display: flex; min-height: 320px; max-height: min(72vh, 960px); min-width: 0; padding: 0; overflow: hidden; }
.agent-workbench-board > :deep(.growth-loading) { margin: auto; }
</style>
