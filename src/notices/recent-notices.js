import { dreamingRuns } from '../dreaming/scheduler.js';
import { PROMOTED_PURPOSE } from '../graphiti/topic-proposals.js';
import { delegatedReviewList } from '../judgment/review-delegation.js';
import { retrospectiveRuns } from '../retrospectives/runs.js';

// The workbench's 「最近你可能需要知道的事」 (Jevons 11-06): what changed lately
// that the person may want to know, each with the one place to act on it. It is
// read from records FULI already keeps; nothing new is stored. A source that
// cannot be read is left out, so one broken record never empties the list.
// Each notice is { id, kind, at, params, href }; the console words it.
export const NOTICE_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICES = 50;

export async function recentNotices({ app, delegation = null, system = null, now = Date.now() }) {
  const space = app.config.personal.spaceId;
  const since = now - NOTICE_WINDOW_DAYS * DAY_MS;
  const projects = await read(() => app.listPersonalProjects({ personalSpaceId: space }), []);
  const context = { app, delegation, system, space, projectName: nameLookup(projects) };
  const lists = await Promise.all([
    promotedTopics(projects),
    read(() => dreamingResults(context), []),
    read(() => retrospectiveResults(context), []),
    read(() => tonborgConfirmations(context), []),
    read(() => teamChanges(context), []),
    read(() => delegatedChanges(context), []),
    read(() => modelProblems(context), []),
    read(() => versionUpdate(context), [])
  ]);
  const items = lists.flat()
    .filter(notice => time(notice.at) >= since)
    .sort((a, b) => time(b.at) - time(a.at))
    .slice(0, MAX_NOTICES);
  return { windowDays: NOTICE_WINDOW_DAYS, items };
}

// A topic Astro made into a project by itself; an undone one is archived and drops out.
function promotedTopics(projects) {
  return projects
    .filter(project => project.profile?.purpose?.startsWith(PROMOTED_PURPOSE) && project.profile?.lifecycle !== 'archived')
    .map(project => {
      const name = project.profile?.name ?? project.project_id;
      return notice('topic_promoted', project.project_id, project.created_at, { project: name },
        `/employees/assistant?${new URLSearchParams({ promoted: project.project_id, topic: name })}`);
    });
}

// A Dreaming run that left something to confirm, or one that stopped.
async function dreamingResults({ app, projectName }) {
  const rows = await dreamingRuns(app);
  return rows.flatMap(row => {
    const project = projectName(row.personalProjectId);
    if (row.status === 'dreamed') {
      const proposed = (row.proposed ?? []).filter(proposal => proposal.status === 'queued').length;
      return proposed ? [notice('dreaming_found', row.id, row.at, { project, sessions: row.sessions ?? 0, proposed }, '/inbox')] : [];
    }
    if (row.status === 'nothing_to_read') return [];
    return [notice('dreaming_stopped', row.id, row.at, { project, status: row.status }, '/models')];
  });
}

// A finished task's retrospective whose lessons wait for the person. One whose
// words a permanent delete took says nothing; the task's view still has it.
async function retrospectiveResults({ app, projectName }) {
  const rows = await retrospectiveRuns(app);
  return rows.flatMap(row => {
    const lessons = (row.lessons ?? []).filter(lesson => lesson.status === 'queued').length;
    if (row.status !== 'written' || row.hard_deleted || !lessons) return [];
    return [notice('retrospective_ready', row.subject?.taskId ?? row.id, row.at,
      { task: row.taskTitle ?? '', project: projectName(row.personalProjectId), lessons }, '/inbox')];
  });
}

// What Tonborg confirmed for the person, one notice a day.
async function tonborgConfirmations({ app, space }) {
  if (!app.judgment) return [];
  const { confirmed } = await delegatedReviewList({ judgment: app.judgment, input: { personalSpaceId: space } });
  const days = new Map();
  for (const entry of confirmed) {
    const day = String(entry.createdAt).slice(0, 10);
    const known = days.get(day);
    days.set(day, { count: (known?.count ?? 0) + 1, at: known && time(known.at) > time(entry.createdAt) ? known.at : entry.createdAt });
  }
  return [...days].map(([day, { count, at }]) => notice('tonborg_confirmed', day, at, { count }, '/inbox'));
}

// FLAs who joined or left a project.
async function teamChanges({ app, space, projectName }) {
  const [active, archived] = await Promise.all([
    read(() => app.listProjectAgents({ personalSpaceId: space }), []),
    read(() => app.listProjectAgents({ personalSpaceId: space, status: 'archived' }), [])
  ]);
  const href = agent => `/agents/${encodeURIComponent(space)}/${encodeURIComponent(agent.agentId)}`;
  // An FLA goes by its display name; its project is where it is assigned when the record names none itself.
  const params = agent => ({ name: agent.profile?.displayName ?? agent.profile?.name ?? agent.agentId,
    project: projectName(agent.personalProjectId ?? agent.assignments?.[0]?.personalProjectId) });
  return [
    ...active.filter(agent => agent.recruitedAt).map(agent => notice('fla_joined', agent.agentId, agent.recruitedAt, params(agent), href(agent))),
    ...archived.filter(agent => agent.archivedAt).map(agent => notice('fla_left', agent.agentId, agent.archivedAt, params(agent), href(agent)))
  ];
}

// A console change an FLA made for the person; its undo is described in AI permissions.
function delegatedChanges({ delegation }) {
  const operations = delegation?.read().operations ?? [];
  return operations
    .filter(operation => operation.status === 'applied')
    .map(operation => notice('delegated_change', operation.id, operation.at, { reason: operation.reason ?? '' }, '/settings'));
}

// A connected model whose latest call failed.
function modelProblems({ app }) {
  const backends = app.modelBackends;
  if (!backends?.health) return [];
  const settings = backends.roles();
  return settings.roles
    .filter(role => role.state === 'enabled')
    .map(role => ({ role, health: backends.health(role.role, role.connection?.id ?? null,
      role.connection ? settings.connections[role.connection.id] : null) }))
    .filter(({ health }) => health?.status === 'failing' && health.at)
    .map(({ role, health }) => notice('model_failing', role.role, health.at, { role: role.role }, '/models'));
}

// A newer FULI is out.
function versionUpdate({ system }) {
  const status = system?.cachedVersionStatus?.();
  if (!status?.updateAvailable || !status.latestVersion || !status.checkedAt) return [];
  return [notice('update_available', status.latestVersion, status.checkedAt, { version: status.latestVersion }, '/settings?tab=version')];
}

function notice(kind, key, at, params, href) {
  return { id: `${kind}:${key}`, kind, at, params, href };
}

function nameLookup(projects) {
  const names = new Map(projects.map(project => [project.project_id, project.profile?.name ?? project.project_id]));
  return id => (id ? names.get(id) ?? id : '');
}

async function read(load, fallback) {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

function time(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}
