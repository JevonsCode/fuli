import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { agentValues } from "@/features/project-agents/task-evidence";

export function useAgentRoster(spaceId: Ref<string>) {
  const agents = ref<ProjectAgentRecord[]>([]);
  const loading = ref(false);
  const error = ref("");
  const rosterBySpace = new Map<string, ProjectAgentRecord[]>();
  let generation = 0;
  async function load() {
    const current = ++generation;
    const requestedSpace = spaceId.value;
    error.value = "";
    if (!spaceId.value) {
      agents.value = [];
      loading.value = false;
      return;
    }
    const cached = rosterBySpace.get(requestedSpace);
    if (cached) {
      agents.value = cached;
    } else if (
      agents.value.some((item) => item.personalSpaceId !== requestedSpace)
    ) {
      // A new space should never render another space's stale identities while
      // its own roster is loading. A refresh in the same space keeps its rows.
      agents.value = [];
    }
    loading.value = true;
    try {
      const value = await getJson<unknown>(
        `/api/project-agents?${new URLSearchParams({ personalSpaceId: requestedSpace })}`,
      );
      if (current !== generation || spaceId.value !== requestedSpace) return;
      // The console API is the canonical camelCase boundary, not raw Provider data.
      const next = agentValues(value).filter(
        (item): item is ProjectAgentRecord =>
          Boolean(
            item &&
            typeof item === "object" &&
            "agentId" in item &&
            "profile" in item &&
            "personalSpaceId" in item &&
            item.personalSpaceId === requestedSpace,
          ),
      );
      rosterBySpace.set(requestedSpace, next);
      agents.value = next;
    } catch (cause) {
      if (current === generation && spaceId.value === requestedSpace)
        error.value =
          cause instanceof Error ? cause.message : t("agentProfiles.loadError");
    } finally {
      if (current === generation && spaceId.value === requestedSpace)
        loading.value = false;
    }
  }
  watch(spaceId, load, { immediate: true });
  return { agents, loading, error, load };
}
