import { ref, watch, type Ref } from "vue";
import { getJson } from "@/api/client";
import { t } from "@/i18n";
import type { ProjectAgentRecord } from "@/types";
import { unknownRecord } from "@/features/project-agents/task-evidence";
import { rosterRecords } from "./useAgentRoster";

export const ROSTER_PAGE_SIZE = 50;

// Agents with open work are read first, then the whole roster in its one
// global order; rows already read are never repeated.
type Phase = "open" | "all";

interface LoadedRoster {
  agents: ProjectAgentRecord[];
  phase: Phase;
  cursor: string | null;
  complete: boolean;
}

// In-memory only: coming back to the directory keeps the pages already read,
// so the reader's scroll position still points at the same rows.
const loadedRosters = new Map<string, LoadedRoster>();

/** Forget every page read so far; tests start from a clean roster. */
export function forgetLoadedRosters() {
  loadedRosters.clear();
}

const emptyRoster =(): LoadedRoster => ({ agents: [], phase: "open", cursor: null, complete: false });

/** The directory roster, one page per request instead of every Agent at once. */
export function useAgentRosterPages(spaceId: Ref<string>, status: Ref<string>) {
  const agents = ref<ProjectAgentRecord[]>([]);
  const loading = ref(false);
  const error = ref("");
  const complete = ref(false);
  let roster = emptyRoster();
  let key = "";
  let generation = 0;

  function show(next: LoadedRoster) {
    roster = next;
    agents.value = next.agents;
    complete.value = next.complete;
  }

  function start() {
    generation += 1;
    key = `${spaceId.value}\n${status.value}`;
    loading.value = false;
    error.value = "";
    const cached = loadedRosters.get(key);
    show(cached ?? emptyRoster());
    return cached ? Promise.resolve() : loadMore();
  }

  async function loadMore() {
    const space = spaceId.value;
    if (!space || loading.value || roster.complete) return;
    const current = generation;
    const from = roster;
    const query = new URLSearchParams({ personalSpaceId: space, limit: String(ROSTER_PAGE_SIZE) });
    if (status.value !== "all") query.set("status", status.value);
    if (from.phase === "open") query.set("work", "open");
    if (from.cursor) query.set("cursor", from.cursor);
    loading.value = true;
    error.value = "";
    let fillFirstScreen = false;
    try {
      const value = await getJson<unknown>(`/api/project-agent-pages?${query}`);
      if (current !== generation) return;
      const page = unknownRecord(value);
      const cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      const ended = page.complete === true;
      // Without a cursor or an explicit end there is no honest next step.
      if (!ended && !cursor) throw new Error(t("agentProfiles.pageBroken"));
      const seen = new Set(from.agents.map((agent) => agent.agentId));
      const added = rosterRecords(value, space).filter((agent) => {
        if (seen.has(agent.agentId)) return false;
        seen.add(agent.agentId);
        return true;
      });
      const next: LoadedRoster = {
        agents: [...from.agents, ...added],
        phase: ended ? "all" : from.phase,
        cursor: ended ? null : cursor,
        complete: ended && from.phase === "all",
      };
      loadedRosters.set(key, next);
      show(next);
      // Few Agents have open work: go straight on to the roster so the first
      // screen is not left nearly empty waiting for a scroll.
      fillFirstScreen = from.phase === "open" && ended && next.agents.length < ROSTER_PAGE_SIZE;
    } catch (cause) {
      if (current === generation)
        error.value = cause instanceof Error ? cause.message : t("agentProfiles.loadError");
    } finally {
      if (current === generation) loading.value = false;
    }
    if (fillFirstScreen && current === generation) await loadMore();
  }

  /** Drop the pages read so far and start again from the first one. */
  function reload() {
    loadedRosters.delete(key);
    return start();
  }

  watch([spaceId, status], start, { immediate: true });
  return { agents, loading, error, complete, loadMore, reload };
}
