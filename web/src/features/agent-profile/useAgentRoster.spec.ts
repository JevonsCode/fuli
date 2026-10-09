import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { ProjectAgentRecord } from "@/types";
import { useAgentRoster } from "./useAgentRoster";

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }));
vi.mock("@/api/client", () => ({ getJson }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));

const agent = (id: string, space = "space-a"): ProjectAgentRecord => ({
  agentId: id,
  personalSpaceId: space,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  profile: {
    name: id,
    responsibility: "Review work",
    capabilities: [],
    initialPreferences: [],
    status: "active",
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useAgentRoster", () => {
  it("keeps the current space roster visible while a refresh is pending", async () => {
    getJson.mockReset();
    getJson.mockResolvedValueOnce([agent("first")]);
    const space = ref("space-a");
    const roster = useAgentRoster(space);
    await flushPromises();

    const refresh = deferred<unknown>();
    getJson.mockReturnValueOnce(refresh.promise);
    const pending = roster.load();
    expect(roster.agents.value.map((item) => item.agentId)).toEqual(["first"]);

    refresh.resolve([agent("second")]);
    await pending;
    expect(roster.agents.value.map((item) => item.agentId)).toEqual(["second"]);
  });

  it("ignores a late response from a previous space", async () => {
    getJson.mockReset();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    getJson.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const space = ref("space-a");
    const roster = useAgentRoster(space);
    await Promise.resolve();

    space.value = "space-b";
    await Promise.resolve();
    first.resolve([agent("old", "space-a")]);
    await Promise.resolve();
    expect(roster.agents.value).toEqual([]);

    second.resolve([agent("new", "space-b")]);
    await flushPromises();
    expect(roster.agents.value.map((item) => item.agentId)).toEqual(["new"]);
  });
});
