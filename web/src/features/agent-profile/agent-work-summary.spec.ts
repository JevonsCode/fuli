import { describe, expect, it } from "vitest";
import {
  isAgentTaskDataComplete,
  summarizeAgentTasks,
} from "./agent-work-summary";

const task = (
  taskId: string,
  status: string,
  participants: Array<{ agentId: string; status: string }>,
  personalSpaceId = "space-a",
) => ({
  taskId,
  personalSpaceId,
  title: `${taskId} title`,
  status,
  participants,
  updatedAt: "2026-10-01T00:00:00Z",
});

describe("agent work summary", () => {
  it("keeps only real active statuses and associates them with participants", () => {
    expect(
      summarizeAgentTasks(
        [
          task("running", "running", [{ agentId: "alpha", status: "running" }]),
          task("review", "awaiting_review", [
            { agentId: "alpha", status: "awaiting_review" },
          ]),
          task("blocked", "blocked", [{ agentId: "beta", status: "blocked" }]),
          task("queued", "queued", [{ agentId: "queued", status: "queued" }]),
          task("stale", "completed", [{ agentId: "stale", status: "running" }]),
          task("done", "completed", [{ agentId: "gamma", status: "completed" }]),
          task("foreign", "running", [{ agentId: "foreign", status: "running" }], "space-b"),
        ],
        "space-a",
      ),
    ).toEqual({
      alpha: { status: "awaiting_review", taskId: "review", title: "review title" },
      beta: { status: "blocked", taskId: "blocked", title: "blocked title" },
      queued: { status: "queued", taskId: "queued", title: "queued title" },
    });
  });

  it("uses an owner identity when a task has no participant rows", () => {
    expect(
      summarizeAgentTasks(
        [
          {
            ...task("owned", "running", []),
            ownerAgentId: "owner",
          },
        ],
        "space-a",
      ),
    ).toEqual({
      owner: { status: "running", taskId: "owned", title: "owned title" },
    });
  });

  it("marks a bounded task page incomplete when the API may have more rows", () => {
    expect(
      isAgentTaskDataComplete(
        {
          tasks: Array.from({ length: 200 }, (_, index) =>
            task(`task-${index}`, "completed", []),
          ),
        },
        200,
      ),
    ).toBe(false);
    expect(isAgentTaskDataComplete({ tasks: [] }, 200)).toBe(true);
    expect(isAgentTaskDataComplete({ tasks: [], has_more: true }, 200)).toBe(false);
  });
});
