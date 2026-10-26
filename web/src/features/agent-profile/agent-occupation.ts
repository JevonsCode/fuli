import { putJson } from "@/api/client";
import { occupationEntry, occupationName } from "@/features/occupations/occupation-catalog";
import type { AgentOccupation, AgentOccupationKey, ProjectAgentRecord } from "@/types";

export const MAX_OCCUPATION_TAGS = 5;

/** The space catalog's name for an occupation; its key until the catalog is read. */
export function occupationLabel(key: AgentOccupationKey) {
  const entry = occupationEntry(key);
  return entry ? occupationName(entry) : key;
}

/** Main role first, then the extra tags, without repeating the role. */
export function occupationLabels(occupation: AgentOccupation | null | undefined) {
  if (!occupation) return [];
  const keys = [
    ...(occupation.role ? [occupation.role] : []),
    ...occupation.tags.filter((tag) => tag !== occupation.role),
  ];
  return keys.map(occupationLabel);
}

export function saveAgentOccupation(
  personalSpaceId: string,
  agentId: string,
  value: { role: AgentOccupationKey | null; tags: AgentOccupationKey[] },
) {
  return putJson<ProjectAgentRecord>(
    `/api/project-agents/${encodeURIComponent(agentId)}/occupation`,
    { personalSpaceId, role: value.role, tags: value.tags },
  );
}
