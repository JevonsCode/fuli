import { ref, watch, type Ref } from 'vue'
import { getJson } from '@/api/client'
import { refreshEmployeeCatalog } from '@/features/employees/catalog'
import { t } from '@/i18n'
import type { ProjectAgentRecord } from '@/types'
import { agentValues } from './task-evidence'
import { attachTasks, mergeAgents, NON_TERMINAL_TASK_STATUSES, normalizeAgent, taskValues } from './agent-roster-records'

/**
 * The space's Agents as 编排 shows them: one merged record per Agent, with
 * its open work from the space-wide task list. Both the collection and an
 * Agent's own page read it, since the page needs every Agent's name for task
 * collaborators and reassignment. Changing space drops the old roster and
 * ignores any read still on its way.
 */
export function useProjectAgentRoster(spaceId: Ref<string>) {
  const agents = ref<ProjectAgentRecord[]>([])
  const loading = ref(false)
  const error = ref('')
  let version = 0

  async function load(space = spaceId.value) {
    if (!space) return
    const current = ++version
    loading.value = true
    error.value = ''
    try {
      const query = new URLSearchParams({ personalSpaceId: space })
      const [agentsResult, tasksResult] = await Promise.allSettled([
        getJson<unknown>(`/api/project-agents?${query}`),
        // The list endpoint is intentionally space-wide: a task can have more
        // than one participant, so filtering only by one Agent would hide
        // collaboration from the collection.
        getJson<unknown>(`/api/project-agent-tasks?${query}`),
      ])
      if (current !== version) return
      void refreshEmployeeCatalog(space)
      if (agentsResult.status === 'rejected') throw agentsResult.reason
      const listed = mergeAgents(agentValues(agentsResult.value), space)
      const tasks = tasksResult.status === 'fulfilled'
        ? taskValues(tasksResult.value).filter((task) => NON_TERMINAL_TASK_STATUSES.has(task.status))
        : []
      agents.value = attachTasks(listed, tasks)
    } catch (cause) {
      if (current === version) error.value = cause instanceof Error ? cause.message : t('projectAgents.loadError')
    } finally {
      if (current === version) loading.value = false
    }
  }

  watch(spaceId, (space) => {
    ++version
    agents.value = []
    error.value = ''
    if (space) void load(space)
    else loading.value = false
  }, { immediate: true })

  /** The Agent a link names, by its current id or an earlier one. */
  function find(agentId: string) {
    return agents.value.find((agent) => agent.personalSpaceId === spaceId.value
      && (agent.agentId === agentId || agent.legacyAgentIds?.includes(agentId))) ?? null
  }

  function update(agentId: string, change: (agent: ProjectAgentRecord) => ProjectAgentRecord) {
    agents.value = agents.value.map((agent) => agent.agentId === agentId ? change(agent) : agent)
  }

  /** A record the edit dialog saved: it replaces that Agent's row for the same project. */
  function put(value: unknown) {
    const saved = normalizeAgent(value, spaceId.value)
    const rest = agents.value.filter((item) => !(item.agentId === saved.agentId
      && saved.personalProjectId && item.personalProjectId === saved.personalProjectId))
    agents.value = mergeAgents([...rest, saved], spaceId.value)
    return saved
  }

  return { agents, loading, error, load, find, update, put }
}
