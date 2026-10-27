import { putJson } from "@/api/client";
import { t } from "@/i18n";
import { tableLabel } from "@/i18n/label-table";
import { occupationEntry, occupationName } from "@/features/occupations/occupation-catalog";
import type { AgentOccupation, AgentOccupationKey, ProjectAgentRecord } from "@/types";

export const MAX_OCCUPATION_TAGS = 5;

/**
 * The space catalog's name for an occupation. Until the catalog is read (or
 * when it cannot be), a built-in reads as its shipped name and any other key
 * as a custom occupation: the key itself is never shown.
 */
export function occupationLabel(key: AgentOccupationKey) {
  const entry = occupationEntry(key);
  if (entry) return occupationName(entry);
  return tableLabel("occupations.builtinNames", key) ?? t("occupations.customName");
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
