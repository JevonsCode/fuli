import type { WorkbenchStatus } from "./agent-workbench";

export interface DirectoryProjectGroup {
  /** null collects Agents with no active project assignment. */
  projectId: string | null;
  agentIds: string[];
  /** Agents whose roster status is reported as running. */
  runningCount: number;
  /** Agents whose work status is still unknown (loading/unreported/unavailable). */
  unknownCount: number;
}

const UNKNOWN: ReadonlySet<WorkbenchStatus> = new Set(["loading", "unreported", "unavailable"]);

/**
 * Group the already ordered, already filtered Agents by project.
 * An Agent assigned to several projects appears in each of them; groups
 * follow the project list order, and the per-group Agent order is kept.
 */
export function groupAgentsByProject(
  orderedAgentIds: readonly string[],
  projectIdsOf: (agentId: string) => readonly string[],
  statusOf: (agentId: string) => WorkbenchStatus | undefined,
  projectOrder: readonly string[],
  selectedProjects: readonly string[] = [],
): DirectoryProjectGroup[] {
  const groups = new Map<string | null, DirectoryProjectGroup>();
  const group = (projectId: string | null) => {
    let value = groups.get(projectId);
    if (!value) {
      value = { projectId, agentIds: [], runningCount: 0, unknownCount: 0 };
      groups.set(projectId, value);
    }
    return value;
  };
  for (const agentId of orderedAgentIds) {
    const projectIds = projectIdsOf(agentId)
      .filter((id) => !selectedProjects.length || selectedProjects.includes(id));
    const status = statusOf(agentId);
    for (const projectId of projectIds.length ? projectIds : [null]) {
      const value = group(projectId);
      value.agentIds.push(agentId);
      if (status === "running") value.runningCount += 1;
      if (!status || UNKNOWN.has(status)) value.unknownCount += 1;
    }
  }
  const rank = new Map(projectOrder.map((id, index) => [id, index]));
  return [...groups.values()].sort((a, b) => {
    if (a.projectId === null || b.projectId === null) return a.projectId === null ? 1 : -1;
    return (rank.get(a.projectId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.projectId) ?? Number.MAX_SAFE_INTEGER)
      || a.projectId.localeCompare(b.projectId);
  });
}
