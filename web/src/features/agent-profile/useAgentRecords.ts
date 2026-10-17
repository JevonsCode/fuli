import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { agentValues } from "@/features/project-agents/task-evidence";

/** One space's Agents; the console API is the canonical camelCase boundary, not raw Provider data. */
export function rosterRecords(value: unknown, spaceId: string): ProjectAgentRecord[] {
  return agentValues(value).filter(
    (item): item is ProjectAgentRecord =>
      Boolean(
        item &&
        typeof item === "object" &&
        "agentId" in item &&
        "profile" in item &&
        "personalSpaceId" in item &&
        item.personalSpaceId === spaceId,
      ),
  );
}

// A page names a handful of Agents; a few requests at a time is enough.
const CONCURRENT_READS = 6;

/**
 * The records of just the Agents a view names, read by id, so no view
 * outside the directory needs the whole roster. Records are keyed by the id
 * asked for. An Agent that no longer exists is left out; any other failure
 * is reported, never shown as a missing Agent.
 */
export function useAgentRecords(spaceId: Ref<string>, agentIds: Ref<string[]>) {
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

  async function readAll(ids: string[], requestedSpace: string) {
    const results: PromiseSettledResult<Awaited<ReturnType<typeof read>>>[] = [];
    for (let start = 0; start < ids.length; start += CONCURRENT_READS)
      results.push(...await Promise.allSettled(
        ids.slice(start, start + CONCURRENT_READS).map((id) => read(id, requestedSpace)),
      ));
    return results;
  }

  async function load(options: { force?: boolean } = {}) {
    const current = ++generation;
    const requestedSpace = spaceId.value;
    if (requestedSpace !== space || options.force) {
      if (requestedSpace !== space) records.value = {};
      settled = new Set();
      space = requestedSpace;
    }
    const missing = requestedSpace
      ? [...new Set(agentIds.value.filter((id) => id && !settled.has(id)))]
      : [];
    error.value = "";
    if (!missing.length) {
      loading.value = false;
      return;
    }
    loading.value = true;
    const results = await readAll(missing, requestedSpace);
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

  /** Show a record the view itself just saved, without reading it again. */
  function put(agentId: string, record: ProjectAgentRecord) {
    records.value = { ...records.value, [agentId]: record };
  }

  watch([spaceId, agentIds], () => load(), { immediate: true });
  return { records, loading, error, load, put };
}
