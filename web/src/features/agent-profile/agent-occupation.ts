import { putJson } from "@/api/client";
import { t } from "@/i18n";
import { occupationEntry, occupationName } from "@/features/occupations/occupation-catalog";
import type { AgentOccupation, AgentOccupationKey, ProjectAgentRecord } from "@/types";

// Built-in keys, used until the space catalog is read.
export const OCCUPATION_KEYS: readonly AgentOccupationKey[] = [
  "lead", "assistant",
  "product", "engineering", "design", "operations", "testing",
  "research", "data", "writing", "management",
];
export const MAX_OCCUPATION_TAGS = 5;

/** The catalog name when known, else the built-in label, else the key itself. */
export function occupationLabel(key: AgentOccupationKey) {
  const entry = occupationEntry(key);
  if (entry) return occupationName(entry);
  const builtin = `agentRedesign.occupation.keys.${key}`;
  const label = t(builtin);
  return label === builtin ? key : label;
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
