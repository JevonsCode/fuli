import type { ProjectAgentRecord, ProjectAgentTaskRecord } from "@/types";

export const agentProfilePath = (space: string, agent: string) =>
  `/agents/${encodeURIComponent(space)}/${encodeURIComponent(agent)}`;
export const agentDisplayName = (agent: ProjectAgentRecord) =>
  agent.profile.displayName || agent.profile.name;
export const activeAssignments = (agent: ProjectAgentRecord) =>
  (agent.assignments ?? []).filter((item) => item.status === "active");
export const profileProjectIds = (agent: ProjectAgentRecord) => [
  ...new Set([
    ...activeAssignments(agent).map((item) => item.personalProjectId),
    ...(!agent.assignments && agent.personalProjectId
      ? [agent.personalProjectId]
      : []),
  ]),
];

const normalized = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
// Human-sized queries only: partial words, any word order, and one Latin typo.
// Deterministic, local and independent of model/token usage.
export function fuzzyMatch(text: string, query: string) {
  const haystack = normalized(text);
  const words = haystack.match(/[a-z0-9]+/g) ?? [];
  return normalized(query)
    .slice(0, 160)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .every(
      (term) =>
        haystack.includes(term) ||
        (/^[a-z]{4,32}$/.test(term) &&
          words.some((word) => oneEditApart(term, word))),
    );
}
function oneEditApart(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (i === Math.min(a.length, b.length)) return true;
  if (a.length === b.length)
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] &&
        a[i + 1] === b[i] &&
        a.slice(i + 2) === b.slice(i + 2))
    );
  return a.length > b.length
    ? a.slice(i + 1) === b.slice(i)
    : a.slice(i) === b.slice(i + 1);
}
export function collaboratorsFor(
  agentId: string,
  tasks: ProjectAgentTaskRecord[],
) {
  const counts = new Map<string, Set<string>>();
  const observed = new Set([
    "running",
    "awaiting_review",
    "completed",
    "failed",
  ]);
  for (const task of tasks) {
    if (
      !observed.has(task.status) ||
      !task.participants.some(
        (person) => person.agentId === agentId && observed.has(person.status),
      )
    )
      continue;
    for (const person of task.participants) {
      if (person.agentId === agentId || !observed.has(person.status)) continue;
      const taskIds = counts.get(person.agentId) ?? new Set<string>();
      taskIds.add(task.taskId);
      counts.set(person.agentId, taskIds);
    }
  }
  return [...counts]
    .map(([agentId, taskIds]) => ({ agentId, count: taskIds.size }))
    .sort((a, b) => b.count - a.count || a.agentId.localeCompare(b.agentId));
}
