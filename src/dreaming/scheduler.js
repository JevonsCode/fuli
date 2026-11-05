import { DREAMING_OPERATION, dreamingReadiness, dreamProject } from './run.js';

const DAY_MS = 86_400_000;

// Each project the person approved dreams once a day. The console host only,
// never every MCP process; the runtime lease keeps it off a manual run. Nothing
// runs until Astro has a model with the dreaming operation (dreamingReadiness).
export function startDreamingScheduler({ app, ownerReads, withLease = (_owner, run) => run(), intervalMs = 1_800_000, now = () => new Date() }) {
  if (!app.modelBackends || !ownerReads) return () => {};
  let running = false, active = null, stopped = false;
  const tick = async () => {
    if (stopped || running || app.getAgentAccessPolicy?.().enabled === false) return;
    if (!app.modelBackends.operationSettings('assistant', DREAMING_OPERATION)) return;
    running = true;
    try {
      const last = await lastRuns(app);
      const projects = await app.listPersonalProjects({ personalSpaceId: app.config.personal.spaceId });
      for (const project of projects) {
        const id = project.project_id;
        if (stopped || project.scope_type === 'temporary' || dreamingReadiness(app, id) !== 'ready') continue;
        if (now().getTime() - (last.get(id) ?? 0) < DAY_MS) continue;
        const since = last.has(id) ? new Date(last.get(id)).toISOString() : null;
        await withLease('dreaming', () => dreamProject(app, ownerReads, { personalProjectId: id, since, now: now() }));
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

// Through the read that refreshes the recovery gate, as the model page reads the log.
export async function dreamingRuns(app) {
  const rows = app.roleSuggestions ? await app.readRoleSuggestions({ limit: 300 }) : [];
  return rows.filter(row => row.operation === DREAMING_OPERATION);
}

async function lastRuns(app) {
  const last = new Map();
  for (const row of await dreamingRuns(app)) {
    const at = Date.parse(row.at);
    const project = row.personalProjectId;
    if (project && at > (last.get(project) ?? 0)) last.set(project, at);
  }
  return last;
}
