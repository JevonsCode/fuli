import { EmployeeError } from './manifest.js';
import { positiveInteger, requiredString } from '../validation/values.js';
import { utf8Preview } from '../text/utf8-preview.js';

// Where each conversation of the projects the person lets Jefa manage stands
// (list_project_conversations): per conversation its project, the project lead,
// the FLA that held it, the clients and native sessions that wrote it, when it
// was last active, and its latest progress with evidence, with when and where to
// read it back. Only what FULI recorded is shown: no agent working memory, no
// conversation events, nothing guessed. The Provider decides what counts as
// evidence (store_agent_conversations.py _with_progress): a checkpoint that is
// not a Stop-hook close, or a task-activity receipt from a native session bound
// to this conversation alone. A Stop-hook close or a heartbeat moves only
// lastActivity; the progress keeps its own time and source.
const PROJECT_PAGE = { default: 5, max: 10 };
const PER_PROJECT = { default: 3, max: 10 };
const PROJECT_CONVERSATIONS = { default: 10, max: 20 };
// Provider reads in flight at once for one call, across projects and FLAs.
const FAN_OUT = 4;
const TITLE_BYTES = 120;
const SESSIONS = 3;
const ID_CHARS = 128;
const ACTIVITY_CHARS = 64;
// The tool's cursor schema allows the same (builtin/jefa/tools.js).
const CURSOR_CHARS = 512;

const invalidCursor = () => new EmployeeError('This cursor is not one this list gave', 400, 'invalid_cursor');
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

// Cursors are opaque to the caller: base64url JSON of ['p', offset] for a page of
// projects, or ['c', projectId, lastActivity, conversationId] for a project's
// conversations, the position of the last row shown (a keyset, so a deep page
// reads no more than the first one).
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(cursor, projectId) {
  if (cursor === undefined) return null;
  if (!isText(cursor, CURSOR_CHARS) || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  let value;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw invalidCursor(); }
  if (!Array.isArray(value)) throw invalidCursor();
  if (projectId === undefined) {
    if (value.length !== 2 || value[0] !== 'p' || !Number.isInteger(value[1]) || value[1] < 1) throw invalidCursor();
    return { offset: value[1] };
  }
  const [kind, project, lastActivity, id] = value;
  if (value.length !== 4 || kind !== 'c' || project !== projectId || !isText(lastActivity, ACTIVITY_CHARS)
    || Number.isNaN(Date.parse(lastActivity)) || !isText(id, ID_CHARS)) throw invalidCursor();
  return { lastActivity, id };
}

// The arguments, checked before anything is read. Without projectId: a page of
// projects (limit, perProject, cursor); with it: that project's conversations
// (limit, cursor).
export function parseConversationProgressArgs(args = {}) {
  const projectId = args.projectId === undefined ? undefined : requiredString(args.projectId, 'projectId', ID_CHARS);
  const page = projectId === undefined ? PROJECT_PAGE : PROJECT_CONVERSATIONS;
  return { projectId,
    limit: args.limit === undefined ? page.default : positiveInteger(args.limit, 'limit', page.max),
    perProject: args.perProject === undefined ? PER_PROJECT.default : positiveInteger(args.perProject, 'perProject', PER_PROJECT.max),
    cursor: decodeCursor(args.cursor, projectId) };
}

// request: parseConversationProgressArgs' answer. managedProjects: the projects
// Jefa manages, named by the host; a projectId outside them is refused.
export async function projectConversationProgress(app, { spaceId, managedProjects, request }) {
  const projects = [...managedProjects].sort((left, right) => compareText(left.id, right.id));
  const run = concurrencyLimit(FAN_OUT);
  if (request.projectId !== undefined) {
    const project = projects.find((entry) => entry.id === request.projectId);
    if (!project) throw new EmployeeError('Jefa does not manage this project', 403, 'project_not_managed');
    const agents = (await app.listProjectAgents({ personalSpaceId: spaceId })) ?? [];
    return { ...await projectView(app, run, { spaceId, project, agents, after: request.cursor, limit: request.limit }),
      guidance: GUIDANCE };
  }
  const offset = request.cursor?.offset ?? 0;
  if (offset && offset >= projects.length) throw invalidCursor();
  const agents = (await app.listProjectAgents({ personalSpaceId: spaceId })) ?? [];
  const page = projects.slice(offset, offset + request.limit);
  const views = await Promise.all(page.map((project) =>
    projectView(app, run, { spaceId, project, agents, after: null, limit: request.perProject })));
  return { projectCount: projects.length, projects: views,
    ...(offset + request.limit < projects.length ? { nextCursor: encodeCursor(['p', offset + request.limit]) } : {}),
    guidance: GUIDANCE };
}

const GUIDANCE = 'progress is the latest evidence a task moved: a checkpoint result (kind checkpoint) or a task-activity '
  + 'receipt from a native session bound to this conversation alone (kind task_activity, reportedBy may be another FLA than '
  + 'handledBy; source names its taskId and eventId); null: none yet. An automatic close '
  + 'or a heartbeat moves only lastActivity. Read a checkpoint back with read_agent_conversation (after: source.sequence - 1, '
  + 'limit: 1). sessions: clients and native sessions FULI recorded (empty: unknown). lead.unknown: the lead could not be read. '
  + 'incomplete: an FLA in unreadable could not be read, so this page and its cursor may miss conversations. '
  + 'Pass nextCursor back, with projectId for a project\'s conversations.';

async function projectView(app, run, { spaceId, project, agents, after, limit }) {
  const members = agents.filter((agent) => (agent.assignments ?? []).some((entry) => entry.status === 'active'
    && entry.personalProjectId === project.id));
  const [lead, reads] = await Promise.all([
    run(() => leadOf(app, spaceId, project.id, agents)),
    Promise.all(members.map((agent) => run(() => conversationsOf(app, spaceId, project.id, agent.agentId, after, limit + 1))
      .then((rows) => ({ agent, rows }), () => ({ agent, rows: null }))))
  ]);
  const unreadable = reads.filter((read) => read.rows === null).map((read) => fla(agents, read.agent.agentId));
  // Each FLA's rows come newest first from the Provider; merged here by parsed time.
  const merged = reads.flatMap(({ agent, rows }) => (rows ?? []).map((row) => ({ row, agent })))
    .sort((left, right) => (Date.parse(right.row.last_activity) - Date.parse(left.row.last_activity))
      || compareText(left.row.id, right.row.id));
  const shown = merged.slice(0, limit);
  const last = shown.at(-1)?.row;
  return { project: { id: project.id, name: project.name }, lead,
    conversations: shown.map(({ row, agent }) => conversationView(project, row, fla(agents, agent.agentId), agents)),
    ...(merged.length > limit ? { nextCursor: encodeCursor(['c', project.id, last.last_activity, last.id]) } : {}),
    ...(unreadable.length ? { unreadable, incomplete: true } : {}) };
}

// The project's lead from its coordination policy (projectAgentCoordinationPolicyRecord):
// null when none is set, { unknown: true } when the policy could not be read.
async function leadOf(app, spaceId, projectId, agents) {
  let policy;
  try {
    policy = await app.getProjectAgentCoordinationPolicy({ personalSpaceId: spaceId, personalProjectId: projectId });
  } catch {
    return { unknown: true };
  }
  return policy?.teamLeadAgentId ? fla(agents, policy.teamLeadAgentId) : null;
}

// One FLA's conversations in one project after a keyset position, newest first.
function conversationsOf(app, spaceId, projectId, agentId, after, limit) {
  // ownerInspection reads as the console does, without the FLA's allowed-clients
  // check: that list says in which clients the FLA may work, not who may see its
  // progress. The person granted Jefa conversations.read over the projects she
  // manages, so this is the person's own read through Jefa's management scope.
  return app.queryAgentConversations({ personalSpaceId: spaceId, personalProjectId: projectId, agentId, mode: 'list',
    limit, withProgress: true, ownerInspection: true,
    ...(after ? { afterPosition: { lastActivity: after.lastActivity, id: after.id } } : {}) })
    .then(({ conversations = [] }) => conversations);
}

// Three roles, each named on its own: the project's lead (projectView), the FLA
// holding the conversation (handledBy) and the FLA that reported the progress
// (reportedBy), which for a task-activity receipt may be another FLA of the project.
function conversationView(project, row, handledBy, agents) {
  const progress = latestEvidence(row, handledBy, agents);
  return { projectId: project.id, conversationId: row.id,
    ...(row.title ? { title: utf8Preview(row.title, TITLE_BYTES) } : {}),
    handledBy, lastActivity: row.last_activity ?? null,
    sessions: (row.sessions ?? []).slice(0, SESSIONS).map((session) => ({ client: session.client ?? null,
      sessionId: session.session_id ?? null, lastSeen: session.last_seen ?? null })),
    progress };
}

// The later of the checkpoint result and the linked task-activity receipt; each
// names its source by ID so the person can check it.
function latestEvidence(row, handledBy, agents) {
  const reported = row.progress;
  const checkpoint = reported ? { kind: 'checkpoint', at: reported.at ?? null, status: reported.status ?? null,
    summary: reported.summary, reportedBy: handledBy, source: reported.source ? { client: reported.source.client ?? null,
      sessionId: reported.source.session_id ?? null, sequence: reported.source.sequence ?? null,
      eventId: reported.source.event_id ?? null } : null } : null;
  const receipt = row.task_activity;
  const activity = receipt ? { kind: 'task_activity', at: receipt.at ?? null, status: receipt.status ?? null,
    summary: receipt.summary, reportedBy: fla(agents, receipt.source.agent_id),
    source: { client: receipt.source.client, sessionId: receipt.source.session_id, taskId: receipt.source.task_id,
      eventId: receipt.source.event_id,
      ...(receipt.same_second_event_ids ? { sameSecondEventIds: receipt.same_second_event_ids } : {}) } } : null;
  if (!checkpoint || !activity) return checkpoint ?? activity;
  return Date.parse(activity.at) > Date.parse(checkpoint.at) ? activity : checkpoint;
}

// An FLA as other views name it (project-team-view.js): display name, then role
// name, then ID, with its employee number where the record has one.
function fla(agents, agentId) {
  const agent = agents.find((entry) => entry.agentId === agentId);
  return { agentId, name: agent?.profile?.displayName || agent?.profile?.name || agentId,
    employeeNumber: agent?.employeeNumber ?? null };
}

// Code-point order, as the Provider orders IDs.
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// At most `max` of the returned tasks run at once; the rest wait their turn.
function concurrencyLimit(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return (task) => new Promise((resolve, reject) => { waiting.push({ task, resolve, reject }); next(); });
}
