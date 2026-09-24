import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { agentValues } from "@/features/project-agents/task-evidence";

export function useAgentRoster(spaceId: Ref<string>) {
  const agents = ref<ProjectAgentRecord[]>([]);
  const loading = ref(false);
  const error = ref("");
  let generation = 0;
  async function load() {
    const current = ++generation;
    const requestedSpace = spaceId.value;
    agents.value = [];
    error.value = "";
    if (!spaceId.value) {
      loading.value = false;
      return;
    }
    loading.value = true;
    try {
      const value = await getJson<unknown>(
        `/api/project-agents?${new URLSearchParams({ personalSpaceId: requestedSpace })}`,
      );
      if (current !== generation) return;
      // The console API is the canonical camelCase boundary, not raw Provider data.
      agents.value = agentValues(value).filter(
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
    } catch (cause) {
      if (current === generation)
        error.value =
          cause instanceof Error ? cause.message : t("agentProfiles.loadError");
    } finally {
      if (current === generation) loading.value = false;
    }
  }
  watch(spaceId, load, { immediate: true });
  return { agents, loading, error, load };
}
