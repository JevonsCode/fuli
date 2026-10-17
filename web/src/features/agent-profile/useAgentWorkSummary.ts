import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import {
  isAgentTaskDataComplete,
  summarizeAgentTasks,
  type AgentWorkSummary,
} from "./agent-work-summary";
import { indexWorkbenchTasks, type WorkbenchTaskSnapshot } from "./agent-workbench";

export type AgentWorkSummaryState =
  | "idle"
  | "loading"
  | "ready"
  | "incomplete"
  | "error";

export function useAgentWorkSummary(spaceId: Ref<string>) {
  const summaries = ref<Record<string, AgentWorkSummary>>({});
  const tasks = ref<Record<string, WorkbenchTaskSnapshot>>({});
  const loading = ref(false);
  const error = ref("");
  const state = ref<AgentWorkSummaryState>("idle");
  const cache = new Map<
    string,
    { summaries: Record<string, AgentWorkSummary>; tasks: Record<string, WorkbenchTaskSnapshot> }
  >();
  let generation = 0;

  async function load() {
    const current = ++generation;
    const requestedSpace = spaceId.value;
    error.value = "";
    if (!requestedSpace) {
      summaries.value = {};
      tasks.value = {};
      loading.value = false;
      state.value = "idle";
      return;
    }
    const cached = cache.get(requestedSpace);
    if (cached) {
      summaries.value = cached.summaries;
      tasks.value = cached.tasks;
    } else if (Object.keys(summaries.value).length || Object.keys(tasks.value).length) {
      // Never show a previous space's work state while the new space is loading.
      summaries.value = {};
      tasks.value = {};
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
      const next = {
        summaries: summarizeAgentTasks(value, requestedSpace),
        tasks: indexWorkbenchTasks(value, requestedSpace),
      };
      cache.set(requestedSpace, next);
      summaries.value = next.summaries;
      tasks.value = next.tasks;
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
  return { summaries, tasks, loading, error, state, load };
}
