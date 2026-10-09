import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import {
  isAgentTaskDataComplete,
  summarizeAgentTasks,
  type AgentWorkSummary,
} from "./agent-work-summary";

export type AgentWorkSummaryState =
  | "idle"
  | "loading"
  | "ready"
  | "incomplete"
  | "error";

export function useAgentWorkSummary(spaceId: Ref<string>) {
  const summaries = ref<Record<string, AgentWorkSummary>>({});
  const loading = ref(false);
  const error = ref("");
  const state = ref<AgentWorkSummaryState>("idle");
  const cache = new Map<string, Record<string, AgentWorkSummary>>();
  let generation = 0;

  async function load() {
    const current = ++generation;
    const requestedSpace = spaceId.value;
    error.value = "";
    if (!requestedSpace) {
      summaries.value = {};
      loading.value = false;
      state.value = "idle";
      return;
    }
    const cached = cache.get(requestedSpace);
    if (cached) {
      summaries.value = cached;
    } else if (Object.keys(summaries.value).length) {
      // Never show a previous space's work state while the new space is loading.
      summaries.value = {};
    }
    loading.value = true;
    state.value = "loading";
    try {
      const query = new URLSearchParams({
        personalSpaceId: requestedSpace,
        limit: "200",
      });
      const value = await getJson<unknown>(`/api/project-agent-tasks?${query}`);
      if (current !== generation || spaceId.value !== requestedSpace) return;
      const next = summarizeAgentTasks(value, requestedSpace);
      cache.set(requestedSpace, next);
      summaries.value = next;
      state.value = isAgentTaskDataComplete(value) ? "ready" : "incomplete";
    } catch (cause) {
      if (current !== generation || spaceId.value !== requestedSpace) return;
      error.value =
        cause instanceof Error ? cause.message : t("agentProfiles.loadError");
      state.value = "error";
    } finally {
      if (current === generation && spaceId.value === requestedSpace) {
        loading.value = false;
      }
    }
  }

  watch(spaceId, load, { immediate: true });
  return { summaries, loading, error, state, load };
}
