import { hostInternalActivity } from './task-entry-activity-origin.js';
import { nameableProjects, projectDisplayName } from './task-entry-project-mention.js';

// "去看看 AICG 项目…" / "问问 AICG 项目…" / "ask the AICG project…" (rec#71):
// the person wants another project's answer, which its lead looks up inside
// that project. The entry names the project and the roundtable address to
// ask; message_agent then finds the lead (or staffs one through Bole), wakes
// it read-only in its own folder and returns its reply. Model-free and
// deterministic: an ask verb right before a registered project's name, and
// the name followed by 项目 / 那边 / 组 / project / team. The current project,
// archived and temporary ones never match. Nothing here sends anything.

const ZH_VERB = '(?:去|再|帮我|你)?(?:看看|看一下|瞧瞧|问问|问一下|去问|请教|咨询|查查|查一下|了解一下)(?:一下)?';
const EN_VERB = '(?:ask|check with|consult|look at how|see how|check how)(?:\\s+the)?';
const ZH_AFTER = '(?:项目|那边|那里|组长|小组|团队)';
const EN_AFTER = '(?:project|team|lead)\\b';
// The roundtable reply the entry asks for; a project named only in passing stays an ordinary prompt.
const GUIDANCE = 'The person asked about another project. Ask each listed project\'s lead now: message_agent(to: its address, body: the '
  + 'person\'s question plus what you already know, wait: true). Answer from the reply and name recipient.name as the '
  + 'source. Do not read that project\'s files or sessions yourself. If status is queued, say so and check later with '
  + 'get_agent_message_status(messageId).';

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The projects the prompt asks about, longest name first.
function askedProjects(projects, taskPrompt) {
  const asked = new Map();
  const names = projects.flatMap(project => [...new Set([project.profile?.name, project.project_id].filter(Boolean))]
    .filter(name => [...name].length >= 2).map(name => ({ project, name })))
    .sort((a, b) => b.name.length - a.name.length);
  for (const { project, name } of names) {
    if (asked.has(project.project_id)) continue;
    const word = escape(name);
    const pattern = new RegExp(`${ZH_VERB}\\s*${word}\\s*${ZH_AFTER}|\\b${EN_VERB}\\s+${word}\\s+${EN_AFTER}`, 'iu');
    if (pattern.test(taskPrompt)) asked.set(project.project_id, project);
  }
  return [...asked.values()];
}

// The entry's roundtable_ask, or null. Only the current project's lead asks
// across projects (resolveProjectLead), so another Agent gets no hint.
export async function roundtableAskEntry(application, input, { personalProjectId, agentId }) {
  const { taskPrompt } = input;
  if (typeof taskPrompt !== 'string' || !taskPrompt.trim() || !personalProjectId || !agentId || !application.roundtable
      || hostInternalActivity(application, input)) return null;
  try {
    const leadId = (await application.personal.getProjectAgentCoordinationPolicy(application.config.personal.spaceId,
      personalProjectId))?.team_lead_agent_id;
    if (leadId !== agentId) return null;
    const others = (await nameableProjects(application)).filter(project => project.project_id !== personalProjectId);
    const asked = askedProjects(others, taskPrompt);
    if (!asked.length) return null;
    return { projects: asked.slice(0, 3).map(project => ({ projectId: project.project_id,
      name: projectDisplayName(project), address: `project:${project.project_id}` })), guidance: GUIDANCE };
  } catch {
    // A hint only: an unreadable project list or policy leaves the entry as it was.
    return null;
  }
}
