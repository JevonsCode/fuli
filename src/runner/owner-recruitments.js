import { storedProjectName } from '../graphiti/project-display-name.js';
import { GLOBAL_WRITE_KINDS } from '../graphiti/global-writes-port.js';
import { withoutControls } from '../text/control-characters.js';
import { writesAnswer, writesEntryId } from './global-writes-outbox.js';
import { GLOBAL_WRITES_ENTRY } from './protocol.js';

// A recruitment of a project this computer owns, for an FLA the host must make
// (docs/runner-roles-design.md §12): while global is a copy here the roster is
// the host's, so this computer's Provider keeps the recruitment as 'blocked'
// with reason recruitment_on_owner, and the host makes the FLA under the
// recruitment's proposed agent id. Each such recruitment becomes one
// `global_writes` entry with one `recruit` op, under an id its recruitment id
// decides, so it is queued once however often this runs. Once the host made
// the FLA, the next copy of global brings it and this computer's Provider
// finishes the recruitment by itself.
//
// Run once when an entry of a project here is answered without an FLA
// (runner-mcp.js). app: this computer's own application (local-scope-server.js).
export const RECRUITMENT_ON_OWNER = 'recruitment_on_owner';
// The host's owner-hire request: ids at most 128, and what it reads of the reason and the project's name
// (host-global-writes.js); a longer one is cut here rather than refused there for good.
const MAX_ID = 128;
const MAX_REASON = 2000;
const MAX_PROJECT_NAME = 200;

// Answers { queued: how many entries this added, waiting: [{ id, personalProjectId }] the entry of each
// recruitment waiting and its project, unsent: [recruitmentId] }: unsent are those no host could make
// (no occupation, no reason), left as they are and named. Every project's are queued; an entry's note
// speaks of its own project's only (runner-mcp.js).
export async function queueOwnerRecruitments({ app, store, sourceApplication, sessionId }) {
  const spaceId = app.config.personal.spaceId;
  const listed = await app.personal.listProjectAgentRecruitments({ personalSpaceId: spaceId, status: 'blocked' });
  const waiting = (Array.isArray(listed) ? listed : listed?.recruitments ?? listed?.items ?? [])
    .filter((recruitment) => recruitment?.status === 'blocked' && recruitment.reason_code === RECRUITMENT_ON_OWNER);
  if (!waiting.length) return { queued: 0, waiting: [], unsent: [] };
  const projects = await app.personal.listPersonalProjects(spaceId).catch(() => []);
  const named = new Map((Array.isArray(projects) ? projects : projects?.projects ?? [])
    .map((project) => [project?.project_id, storedProjectName(project)]));
  let queued = 0;
  const entries = [];
  const unsent = [];
  for (const recruitment of waiting) {
    const input = recruitInput(recruitment, named.get(recruitment.personal_project_id));
    if (!input) {
      unsent.push(recruitment.recruitment_id);
      continue;
    }
    const id = writesEntryId('recruit', recruitment.recruitment_id);
    entries.push({ id, personalProjectId: recruitment.personal_project_id ?? null });
    if (store.entry(id)) continue;
    if (store.enqueue({ id, tool: GLOBAL_WRITES_ENTRY, input: { ops: [{ kind: GLOBAL_WRITE_KINDS.recruit, v: 1, input }] },
      sourceApplication, sessionId })) queued += 1;
  }
  return { queued, waiting: entries, unsent };
}

// Recheck the durable request immediately before forwarding. An older follower can
// have a terminal task with a still-blocked recruitment, so read both records.
export async function ownerRecruitmentState(provider, personalSpaceId, input) {
  const listed = await provider.listProjectAgentRecruitments({ personalSpaceId, taskId: input.taskId });
  const rows = Array.isArray(listed) ? listed : listed?.recruitments ?? listed?.items;
  const row = rows?.find(item => item.recruitment_id === input.recruitmentId);
  if (!row || row.proposed_agent_id !== input.proposedAgentId) return 'unknown';
  if (row.status === 'fulfilled') return 'fulfilled';
  if (row.status === 'cancelled') return 'withdrawn';
  if (row.status !== 'blocked' || row.reason_code !== RECRUITMENT_ON_OWNER) return 'unknown';
  if (!row.task_id) return 'waiting';
  const answer = await provider.viewProjectAgentTask(personalSpaceId, row.task_id,
    { personalProjectId: row.personal_project_id, includeEvents: false });
  const task = answer?.task ?? answer;
  if (task?.task_id !== row.task_id) return 'unknown';
  if (['cancelled', 'completed', 'failed'].includes(task.status)) return 'withdrawn';
  return task.status === 'awaiting_recruitment' ? 'waiting' : 'unknown';
}

// Where the recruitments of these entries stand, for the entry's note (local-answer-note.js):
// { queued, refused: [code] }, or null when there are none.
export function recruitmentState(store, ids) {
  if (!ids.length) return null;
  const answers = ids.map((id) => writesAnswer(store, id, 1));
  return { queued: answers.reduce((sum, answer) => sum + answer.queued, 0),
    refused: answers.flatMap((answer) => answer.refused.map(({ code }) => code)) };
}

// The recruit op as the host takes it (host-global-writes.js), or null when one of what it needs is missing.
function recruitInput(recruitment, projectName) {
  const recruitmentId = recruitment.recruitment_id;
  const proposedAgentId = recruitment.proposed_agent_id;
  const reason = typeof recruitment.reason === 'string' ? withoutControls(recruitment.reason).slice(0, MAX_REASON) : '';
  const project = withoutControls(typeof projectName === 'string' && projectName ? projectName
    : String(recruitment.personal_project_id ?? '')).slice(0, MAX_PROJECT_NAME);
  const occupation = recruitment.occupation;
  if (!validId(recruitmentId) || !validId(proposedAgentId) || !reason || !project || !recruitment.proposed_profile
    || typeof occupation?.role !== 'string') return null;
  return { recruitmentId, proposedAgentId, taskId: recruitment.task_id,
    recruitmentSourceApplication: recruitment.trigger_source_application, profile: recruitment.proposed_profile,
    occupation: { role: occupation.role, tags: Array.isArray(occupation.tags) ? occupation.tags : [] },
    reason, projectName: project };
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
}
