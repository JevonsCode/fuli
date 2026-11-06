import { dreamingConnected, dreamingNewSessions, dreamingReadiness } from './run.js';
import { dreamingRuns, dreamingSince } from './scheduler.js';

// The model page's Dreaming card in one read (11-06): each project Dreaming may
// read, how many sessions its next run would read, and what its last run did.
// Counts only: nothing is sent to a model and no session's words are in it.
export async function dreamingProjects(app) {
  if (!dreamingConnected(app)) return { readiness: 'needs_model', projects: [] };
  const [runs, projects] = await Promise.all([
    dreamingRuns(app),
    app.listPersonalProjects({ personalSpaceId: app.config.personal.spaceId })
  ]);
  const latest = latestRuns(runs);
  const listed = await Promise.all(projects.filter(project => project.scope_type !== 'temporary').map(async (project) => {
    const id = project.project_id;
    const readiness = dreamingReadiness(app, id);
    return { personalProjectId: id, name: project.profile?.name ?? id, readiness,
      // A project not approved for the model is not listed further.
      newSessions: readiness === 'ready' ? await dreamingNewSessions(app, id, dreamingSince(runs, id)) : null,
      lastRun: runView(latest.get(id)) };
  }));
  return { readiness: 'ready', projects: listed };
}

function latestRuns(runs) {
  const latest = new Map();
  for (const row of runs) {
    const known = latest.get(row.personalProjectId);
    if (row.personalProjectId && (!known || Date.parse(row.at) > Date.parse(known.at))) latest.set(row.personalProjectId, row);
  }
  return latest;
}

// What landed in the review queue, as a count: the card links there.
function runView(row) {
  if (!row) return null;
  return { at: row.at, status: row.status, sessions: row.sessions ?? 0,
    proposed: (row.proposed ?? []).filter(proposal => proposal.status === 'queued').length };
}
