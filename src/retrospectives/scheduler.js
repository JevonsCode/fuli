import { dreamingConnected, dreamingReadiness } from '../dreaming/run.js';
import { retrospectTask, retrospectiveWorthy } from './run.js';
import { retrospectiveRuns } from './runs.js';

const DAY_MS = 86_400_000;
// Only tasks finished lately: turning Dreaming on does not look back over all past work.
const RECENT_DAYS = 3;
const TASK_PAGE = 50;
// A few per tick, so a burst of finished tasks spreads its model calls out.
const PER_TICK = 3;
// A run that failed (a model error, a budget window) is tried again on a later tick, this many times in all.
const MAX_ATTEMPTS = 3;

// Finished tasks get their retrospective on the console host only, never in an
// MCP process: FLAs report a task completed from their own sessions, so the
// host looks for newly completed tasks on each tick. Nothing runs until Astro
// has a model with Dreaming on; the task's project must be approved for it.
export function startRetrospectiveScheduler({ app, withLease = (_owner, run) => run(), intervalMs = 1_800_000, now = () => new Date() }) {
  if (!app.modelBackends) return () => {};
  let running = false, active = null, stopped = false;
  // Attempts whose row could not be written still count: they are not paid for again and again.
  const tried = new Map();
  const tick = async () => {
    if (stopped || running || app.getAgentAccessPolicy?.().enabled === false) return;
    if (!dreamingConnected(app)) return;
    running = true;
    try {
      const due = await dueTasks(app, await retrospectiveRuns(app), tried, now());
      for (const task of due.slice(0, PER_TICK)) {
        if (stopped) break;
        tried.set(task.taskId, (tried.get(task.taskId) ?? 0) + 1);
        await withLease('retrospective', () => retrospectTask(app, task, { now: now() }));
      }
    } catch { /* The next tick tries again; a failed run is not the person's to handle. */ }
    finally { running = false; }
  };
  const timer = setInterval(() => {
    if (!running && !stopped) active = tick();
  }, intervalMs);
  timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await active; };
}

// One retrospective per task: a task with a written one, or out of attempts, is done.
async function dueTasks(app, runs, tried, at) {
  const written = new Set();
  const logged = new Map();
  for (const row of runs) {
    const taskId = row.subject?.taskId;
    if (row.status === 'written') written.add(taskId);
    logged.set(taskId, (logged.get(taskId) ?? 0) + 1);
  }
  const attempts = taskId => Math.max(tried.get(taskId) ?? 0, logged.get(taskId) ?? 0);
  const since = at.getTime() - RECENT_DAYS * DAY_MS;
  const tasks = await app.listProjectAgentTasks({ personalSpaceId: app.config.personal.spaceId, status: 'completed', limit: TASK_PAGE });
  return tasks.filter(task => retrospectiveWorthy(task) && !written.has(task.taskId) && attempts(task.taskId) < MAX_ATTEMPTS
    && Date.parse(task.completedAt ?? task.updatedAt ?? '') >= since && dreamingReadiness(app, task.personalProjectId) === 'ready');
}
