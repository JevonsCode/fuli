import type { WorkbenchStatus } from "./agent-workbench";

export interface DirectoryProjectGroup {
  projectId: string;
  agentIds: string[];
  /** Agents whose roster status is reported as running. */
  runningCount: number;
  /** Agents whose work status is still unknown (loading/unreported/unavailable). */
  unknownCount: number;
}

const UNKNOWN: ReadonlySet<WorkbenchStatus> = new Set(["loading", "unreported", "unavailable"]);

/**
 * Group the already ordered, already filtered Agents by formal project.
 * An Agent assigned to several formal projects appears in each of them; groups
 * follow the formal project list order, and the per-group Agent order is kept.
 * Unassigned Agents and non-formal projects outside `projectOrder` are omitted.
 */
export function groupAgentsByProject(
  orderedAgentIds: readonly string[],
  projectIdsOf: (agentId: string) => readonly string[],
  statusOf: (agentId: string) => WorkbenchStatus | undefined,
  projectOrder: readonly string[],
  selectedProjects: readonly string[] = [],
  includeEmpty: boolean | { includeEmpty?: boolean } = false,
): DirectoryProjectGroup[] {
  const formalIds = new Set(
    projectOrder.filter((id) => !selectedProjects.length || selectedProjects.includes(id)),
  );
  const groups = new Map<string, DirectoryProjectGroup>();
  const group = (projectId: string) => {
    let value = groups.get(projectId);
    if (!value) {
      value = { projectId, agentIds: [], runningCount: 0, unknownCount: 0 };
      groups.set(projectId, value);
    }
    return value;
  };
  const showEmpty = typeof includeEmpty === "boolean" ? includeEmpty : Boolean(includeEmpty?.includeEmpty);
  if (showEmpty) {
    for (const projectId of projectOrder) {
      if (formalIds.has(projectId)) group(projectId);
    }
  }
  for (const agentId of orderedAgentIds) {
    const projectIds = projectIdsOf(agentId).filter((id) => formalIds.has(id));
    const status = statusOf(agentId);
    for (const projectId of projectIds) {
      const value = group(projectId);
      value.agentIds.push(agentId);
      if (status === "running") value.runningCount += 1;
      if (!status || UNKNOWN.has(status)) value.unknownCount += 1;
    }
  }
  const rank = new Map(projectOrder.map((id, index) => [id, index]));
  return [...groups.values()].sort((a, b) => (
    (rank.get(a.projectId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.projectId) ?? Number.MAX_SAFE_INTEGER)
      || a.projectId.localeCompare(b.projectId)
  ));
}
