import { dreamingRuns } from '../dreaming/scheduler.js';
import { PROMOTED_PURPOSE } from '../graphiti/topic-proposals.js';
import { delegatedReviewList } from '../judgment/review-delegation.js';
import { retrospectiveRuns } from '../retrospectives/runs.js';

// The workbench's 「最近你可能需要知道的事」 (Jevons 11-06): what changed lately
// that the person may want to know, each with the one place to act on it. It is
// read from records FULI already keeps; nothing new is stored. A source that
// cannot be read is left out, so one broken record never empties the list.
// Each notice is { id, kind, at, params, href } and, where its record names
// them, projectId and agentId; the console words it. The workbench reads the
// first page of the last two weeks; the list's own page (/workbench/notices)
// reads up to 90 days, filtered and a page at a time.
export const NOTICE_WINDOW_DAYS = 14;
export const MAX_NOTICE_WINDOW_DAYS = 90;
const NOTICE_PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `query` (all optional): days, kinds, projectIds, agentIds, text (matched
 * against what the notice names), sort ('newest' | 'oldest'), cursor (the
 * nextCursor of the page before) and limit.
 */
export async function recentNotices({ app, delegation = null, system = null, now = Date.now(), query = {} }) {
  const space = app.config.personal.spaceId;
  const days = query.days ?? NOTICE_WINDOW_DAYS;
  const since = now - days * DAY_MS;
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
  const direction = query.sort === 'oldest' ? -1 : 1;
  const matching = lists.flat()
    .filter(notice => time(notice.at) >= since && matches(notice, query))
    .sort((a, b) => direction * (time(b.at) - time(a.at)) || a.id.localeCompare(b.id));
  const start = Number(query.cursor ?? 0);
  const end = start + (query.limit ?? NOTICE_PAGE_SIZE);
  return { windowDays: days, total: matching.length, items: matching.slice(start, end),
    nextCursor: end < matching.length ? String(end) : null };
}

function matches(notice, { kinds = [], projectIds = [], agentIds = [], text = '' }) {
  if (kinds.length && !kinds.includes(notice.kind)) return false;
  if (projectIds.length && !projectIds.includes(notice.projectId)) return false;
  if (agentIds.length && !agentIds.includes(notice.agentId)) return false;
  const needle = text.trim().toLowerCase();
  return !needle || Object.values(notice.params).some(value => String(value).toLowerCase().includes(needle));
}

// A topic Astro made into a project by itself; an undone one is archived and drops out.
function promotedTopics(projects) {
  return projects
    .filter(project => project.profile?.purpose?.startsWith(PROMOTED_PURPOSE) && project.profile?.lifecycle !== 'archived')
    .map(project => {
      const name = project.profile?.name ?? project.project_id;
      return notice('topic_promoted', project.project_id, project.created_at, { project: name },
        `/employees/assistant?${new URLSearchParams({ promoted: project.project_id, topic: name })}`, { projectId: project.project_id });
    });
}

// A Dreaming run that left something to confirm, or one that stopped.
async function dreamingResults({ app, projectName }) {
  const rows = await dreamingRuns(app);
  return rows.flatMap(row => {
    const project = projectName(row.personalProjectId);
    const refs = { projectId: row.personalProjectId };
    if (row.status === 'dreamed') {
      const proposed = (row.proposed ?? []).filter(proposal => proposal.status === 'queued').length;
      return proposed ? [notice('dreaming_found', row.id, row.at, { project, sessions: row.sessions ?? 0, proposed }, '/inbox', refs)] : [];
    }
    if (row.status === 'nothing_to_read') return [];
    return [notice('dreaming_stopped', row.id, row.at, { project, status: row.status }, '/models', refs)];
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
      { task: row.taskTitle ?? '', project: projectName(row.personalProjectId), lessons }, '/inbox', { projectId: row.personalProjectId })];
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
  const projectOf = agent => agent.personalProjectId ?? agent.assignments?.[0]?.personalProjectId;
  const params = agent => ({ name: agent.profile?.displayName ?? agent.profile?.name ?? agent.agentId, project: projectName(projectOf(agent)) });
  const refs = agent => ({ agentId: agent.agentId, projectId: projectOf(agent) });
  return [
    ...active.filter(agent => agent.recruitedAt).map(agent => notice('fla_joined', agent.agentId, agent.recruitedAt, params(agent), href(agent), refs(agent))),
    ...archived.filter(agent => agent.archivedAt).map(agent => notice('fla_left', agent.agentId, agent.archivedAt, params(agent), href(agent), refs(agent)))
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

function notice(kind, key, at, params, href, { projectId, agentId } = {}) {
  return { id: `${kind}:${key}`, kind, at, params, href,
    ...(projectId ? { projectId } : {}), ...(agentId ? { agentId } : {}) };
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
