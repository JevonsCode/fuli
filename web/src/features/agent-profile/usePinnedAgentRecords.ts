import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { rosterRecords } from "./useAgentRoster";

/**
 * The records of the pinned Agents only, read one by one, so the sidebar
 * never needs the whole roster. A pin whose Agent no longer exists is left
 * out, as before; any other failure is reported, not hidden.
 */
export function usePinnedAgentRecords(spaceId: Ref<string>, pinnedIds: Ref<string[]>) {
  const records = ref<Record<string, ProjectAgentRecord>>({});
  const loading = ref(false);
  const error = ref("");
  // Ids already answered for this space: a record, or known to be gone.
  let settled = new Set<string>();
  let space = "";
  let generation = 0;

  async function read(agentId: string, requestedSpace: string) {
    try {
      const value = await getJson<unknown>(
        `/api/project-agents/${encodeURIComponent(agentId)}?${new URLSearchParams({ personalSpaceId: requestedSpace })}`,
      );
      return { agentId, record: rosterRecords([value], requestedSpace)[0] ?? null };
    } catch (cause) {
      if ((cause as { status?: unknown } | null)?.status === 404) return { agentId, record: null };
      throw cause;
    }
  }

  async function load(options: { force?: boolean } = {}) {
    const current = ++generation;
    const requestedSpace = spaceId.value;
    if (requestedSpace !== space || options.force) {
      if (requestedSpace !== space) records.value = {};
      settled = new Set();
      space = requestedSpace;
    }
    const missing = requestedSpace ? pinnedIds.value.filter((id) => !settled.has(id)) : [];
    error.value = "";
    if (!missing.length) {
      loading.value = false;
      return;
    }
    loading.value = true;
    const results = await Promise.allSettled(missing.map((id) => read(id, requestedSpace)));
    if (current !== generation) return;
    const next = { ...records.value };
    for (const result of results) {
      if (result.status === "rejected") {
        error.value ||= result.reason instanceof Error ? result.reason.message : t("agentProfiles.loadError");
        continue;
      }
      settled.add(result.value.agentId);
      if (result.value.record) next[result.value.agentId] = result.value.record;
      else delete next[result.value.agentId];
    }
    records.value = next;
    loading.value = false;
  }

  watch([spaceId, pinnedIds], () => load(), { immediate: true });
  return { records, loading, error, load };
}
