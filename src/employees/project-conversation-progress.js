import { EmployeeError } from './manifest.js';
import { AUTO_CLOSE_SUMMARY, AUTO_KEEP_REASON } from '../conversations/stop-auto-close.js';

// Where each conversation of the projects the person lets Jefa manage stands
// (list_project_conversations): per conversation its project, the project lead,
// the FLA that held it, the clients and native sessions that wrote it, when it
// was last active, and its latest task result that a checkpoint reported, with
// when and where to read it back. Only what FULI recorded is shown: no agent
// memory, no conversation text, and nothing guessed. A Stop-hook close or a
// conversation with no task result counts as activity, never as progress.
const PROJECT_PAGE = { default: 5, max: 10 };
const PER_PROJECT = { default: 3, max: 10 };
const PROJECT_CONVERSATIONS = { default: 10, max: 20 };
// A Provider list answers at most 50 rows; deeper pages read on in steps.
const PROVIDER_PAGE = 50;
const DEEPEST = 500;
const TITLE_BYTES = 120;
const SESSIONS = 3;
const NOT_PROGRESS = new Set([AUTO_CLOSE_SUMMARY, AUTO_KEEP_REASON]);

const bounded = (value, bytes) => {
  const raw = Buffer.from(String(value ?? ''));
  return raw.length <= bytes ? String(value ?? '') : raw.subarray(0, bytes).toString().replace(/�+$/, '') + '…';
};
const count = (value, { default: fallback, max }) => Number.isInteger(value) ? Math.min(Math.max(value, 1), max) : fallback;
function offsetOf(cursor, kind) {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  const match = new RegExp(`^${kind}:(\\d{1,4})$`).exec(String(cursor));
  if (!match || Number(match[1]) > DEEPEST) throw new EmployeeError('This cursor is not one this list gave', 400, 'invalid_cursor');
  return Number(match[1]);
}

// args: { projectId?, cursor?, limit?, perProject? }. Without projectId, a page of
// projects (cursor p:<n>) with each one's latest conversations; with it, that one
// project's conversations (cursor c:<n>). projectId must be a project Jefa manages.
export async function projectConversationProgress(app, { spaceId, managedProjects, args = {} }) {
  const projects = [...managedProjects].sort((left, right) => left.id.localeCompare(right.id));
  const agents = (await app.listProjectAgents({ personalSpaceId: spaceId })) ?? [];
  if (args.projectId !== undefined) {
    const project = projects.find((entry) => entry.id === args.projectId);
    if (!project) throw new EmployeeError('Jefa does not manage this project', 403, 'project_not_managed');
    const offset = offsetOf(args.cursor, 'c');
    const limit = count(args.limit, PROJECT_CONVERSATIONS);
    const view = await projectView(app, spaceId, project, agents, offset, limit);
    return { project: view.project, lead: view.lead, conversations: view.conversations,
      ...(view.more ? { nextCursor: `c:${offset + limit}` } : {}), ...(view.unreadable.length ? { unreadable: view.unreadable } : {}),
      guidance: GUIDANCE };
  }
  const offset = offsetOf(args.cursor, 'p');
  const limit = count(args.limit, PROJECT_PAGE);
  const perProject = count(args.perProject, PER_PROJECT);
  const page = projects.slice(offset, offset + limit);
  const views = await Promise.all(page.map((project) => projectView(app, spaceId, project, agents, 0, perProject)));
  return { projectCount: projects.length,
    projects: views.map((view) => ({ project: view.project, lead: view.lead, conversations: view.conversations,
      moreConversations: view.more, ...(view.unreadable.length ? { unreadable: view.unreadable } : {}) })),
    ...(offset + limit < projects.length ? { nextCursor: `p:${offset + limit}` } : {}), guidance: GUIDANCE };
}

const GUIDANCE = 'progress is the latest task result a checkpoint reported (null: none yet; an automatic close is not one); '
  + 'progress.source, when recorded, is the checkpoint to read back with read_agent_conversation (after: sequence - 1, limit: 1, eventId); '
  + 'sessions are the clients and native sessions FULI recorded (empty: unknown). Pass a project\'s moreConversations on with projectId and cursor.';

async function projectView(app, spaceId, project, agents, offset, limit) {
  const members = agents.filter((agent) => (agent.assignments ?? []).some((entry) => entry.status === 'active'
    && entry.personalProjectId === project.id));
  const leadId = (await app.getProjectAgentCoordinationPolicy({ personalSpaceId: spaceId, personalProjectId: project.id })
    .catch(() => null))?.team_lead_agent_id ?? null;
  const lead = leadId ? { agentId: leadId, name: agentName(agents, leadId) } : null;
  const unreadable = [];
  const rows = (await Promise.all(members.map(async (agent) => {
    try {
      return (await conversationsOf(app, spaceId, project.id, agent.agentId, offset + limit + 1))
        .map((row) => ({ row, agent }));
    } catch {
      unreadable.push({ agentId: agent.agentId, name: agentName(agents, agent.agentId) });
      return [];
    }
  }))).flat().sort((left, right) => String(right.row.last_activity ?? '').localeCompare(String(left.row.last_activity ?? ''))
    || left.row.id.localeCompare(right.row.id));
  return { project: { id: project.id, name: project.name }, lead, unreadable,
    more: rows.length > offset + limit,
    conversations: rows.slice(offset, offset + limit).map(({ row, agent }) => conversationView(project, row, agent, agents)) };
}

// The newest `wanted` conversations of one FLA in one project, newest first.
async function conversationsOf(app, spaceId, projectId, agentId, wanted) {
  const found = [];
  while (found.length < wanted) {
    const size = Math.min(PROVIDER_PAGE, wanted - found.length);
    // As the console reads them (ownerInspection): any client, the person's own read scope.
    const { conversations = [] } = await app.queryAgentConversations({ personalSpaceId: spaceId, personalProjectId: projectId,
      agentId, mode: 'list', after: found.length, limit: size, withProgress: true, ownerInspection: true });
    found.push(...conversations);
    if (conversations.length < size) break;
  }
  return found;
}

function conversationView(project, row, agent, agents) {
  const progress = [...(row.recent_tasks ?? [])].reverse()
    .find((task) => typeof task?.summary === 'string' && task.summary.trim() && !NOT_PROGRESS.has(task.summary.trim()));
  const handledBy = { agentId: agent.agentId, name: agentName(agents, agent.agentId) };
  return { projectId: project.id, conversationId: row.id,
    ...(row.title ? { title: bounded(row.title, TITLE_BYTES) } : {}),
    handledBy, lastActivity: row.last_activity ?? null,
    sessions: (row.sessions ?? []).slice(0, SESSIONS).map((session) => ({ client: session.client ?? null,
      sessionId: session.session_id ?? null, lastSeen: session.last_seen ?? null })),
    progress: progress ? { at: progress.at ?? null, status: progress.status ?? null, summary: progress.summary,
      reportedBy: handledBy, source: progress.source ?? null, locator: { conversationId: row.id, at: progress.at ?? null } } : null };
}

function agentName(agents, agentId) {
  const agent = agents.find((entry) => entry.agentId === agentId);
  return agent?.profile?.displayName ?? agent?.profile?.name ?? agentId;
}
