import { personCandidates } from './task-entry-named-fla.js';
import { projectKnowledgeIndex } from './task-knowledge-recall.js';
import { singleLine } from '../text/single-line.js';
import { utf8Preview } from '../text/utf8-preview.js';

// `@FLG … 一起看` (rec#55 mode 1): the session works with the confirmed
// members in mind instead of waking them. This is the one read it gets: a
// small index of each member, built from the reads the Agent tools already
// make (the person's FLA roster with each FLA's projects, list_project_agent_tasks,
// standing assignments, and task entry's project knowledge index), never a
// dump. Full items are read on demand with those tools.
//
// Read-only, and only these members and their projects. Working memory is
// never read: every FLA's memory is private to it (private_agent_project /
// private_agent_global), and only role and assignment data crosses to another
// Agent (project-agent-team-context.js), so the index says it was withheld.

const TASK_LIMIT = 3;
const PROJECT_LIMIT = 3;
const KNOWLEDGE_LIMIT = 3;
const TEXT_BYTES = 60;
const WITHHELD = 'working memory: private to each FLA (private_agent_project/private_agent_global), not loaded';
const READ = 'Index only. Read an item when needed: view_project_agent_task(taskId), list_project_agent_tasks(agentId), '
  + 'search_current_project_knowledge(personalProjectId, focused queries).';

// members: [{ agentId, projectId, name, project, occupation }] as confirmed.
// text: what the person asked; the members' names are not searched for.
export async function groupMemberContext(application, members, text, { sourceApplication, sessionId }) {
  const spaceId = application.config.personal.spaceId;
  const placements = await personCandidates(application).catch(() => null);
  const standing = standingResponsibilities(application, spaceId);
  const views = await Promise.all(members.map(member => memberView(application, spaceId, member, placements, standing)));
  const projects = [...new Set(views.flatMap(view => view.projects.map(([id]) => id)))].slice(0, PROJECT_LIMIT);
  const query = withoutNames(text, members);
  const knowledge = (await Promise.all(projects.map(async id => {
    try {
      const index = await projectKnowledgeIndex(application, id, query,
        { sourceApplication, sessionId, agentToolName: 'flg_member_knowledge_index' });
      return index ? [id, index.items.slice(0, KNOWLEDGE_LIMIT)] : null;
    } catch { return null; }
  }))).filter(Boolean);
  return { members: views, ...(knowledge.length ? { knowledge } : {}), withheld: WITHHELD, read: READ };
}

async function memberView(application, spaceId, member, placements, standing) {
  let tasks = null;
  try {
    tasks = await application.listProjectAgentTasks({ personalSpaceId: spaceId, agentId: member.agentId, limit: TASK_LIMIT });
  } catch { /* said as unavailable */ }
  // Where the roster cannot be read, the project the member was chosen in.
  const placed = placements?.filter(item => item.agentId === member.agentId && item.projectId)
    ?? (member.projectId ? [member] : []);
  const responsibility = placed[0]?.responsibility;
  return { agent_id: member.agentId, name: member.name, ...(member.occupation ? { occupation: member.occupation } : {}),
    ...(responsibility ? { responsibility: short(responsibility) } : {}),
    projects: placed.map(item => [item.projectId, item.project]),
    ...(standing.get(member.agentId) ? { standing: standing.get(member.agentId) } : {}),
    tasks: tasks ? tasks.slice(0, TASK_LIMIT).map(task => [task.taskId, short(task.title), task.status]) : 'unavailable' };
}

// What each lead's standing assignments make it answer for.
function standingResponsibilities(application, spaceId) {
  const byLead = new Map();
  let active = [];
  try { active = application.standingAssignments?.list(spaceId) ?? []; } catch { /* none said */ }
  for (const item of active) {
    byLead.set(item.leadAgentId, [...byLead.get(item.leadAgentId) ?? [], short(item.responsibility || item.terms.join('、'))]);
  }
  return byLead;
}

// A name as the roster writes it would be searched as a product name; written
// otherwise (all lower case) it is no search term anyway.
function withoutNames(text, members) {
  return members.reduce((rest, member) => rest.split(member.name).join(' '), singleLine(text));
}

function short(value) {
  return utf8Preview(singleLine(value), TEXT_BYTES);
}
