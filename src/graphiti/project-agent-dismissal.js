import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { renderAgentHandoff } from '../agents/directory-snapshots.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';
import { scopedAgentMemoryView } from './project-agent-memory.js';

// Dismissal ("开除"): the one way an Agent leaves. Bole asks the person why,
// and both entries (a client session today, Bole's own model later) call this
// port. The reason becomes a few lessons that later Agents of the same
// occupation or project look up on demand; they are never loaded for them.
const MIN_REASON_LENGTH = 4;
const LESSON_TOOL = 'list_agent_dismissal_lessons';
// Stand-ins people or Agents type instead of a reason, compared without case,
// spaces or punctuation. A real reason says what went wrong.
const PLACEHOLDER_REASONS = new Set([
  'archivedbyuser', 'archived', 'archive', 'dismiss', 'dismissed', 'fired', 'noreason', 'none',
  'unknown', 'test', 'todo', 'tbd', '无', '没有', '没有理由', '无理由', '不知道', '开除', '归档', '离职'
]);
const LESSON_HINT_GUIDANCE = 'Agents of this occupation or project were dismissed before. Query their lessons only when they bear on the work; nothing of them is loaded here.';

export async function dismissProjectAgent(application, input) {
  const reason = dismissalReason(input.reason);
  const lessons = (input.lessons ?? []).map(lesson => lesson.trim());
  const agent = await application.getProjectAgent({ personalSpaceId: input.personalSpaceId, agentId: input.agentId });
  const handoff = renderAgentHandoff({
    agent: { ...agent, profile: { ...agent.profile, status: 'archived' } },
    reason, lessons: lessons.length ? lessons : [reason],
    layers: await memoryLayers(application, agent), generatedAt: new Date().toISOString()
  });
  return dismissalReceipt(await application.personal.dismissProjectAgent(input.agentId, {
    personal_space_id: input.personalSpaceId, reason, lessons, handoff,
    source_application: input.sourceApplication ?? null, source_session_id: input.sourceSessionId ?? null
  }));
}

export async function listAgentDismissalLessons(application, input) {
  const value = await application.personal.listProjectAgentDismissalLessons({
    personalSpaceId: input.personalSpaceId, occupations: input.occupations ?? [],
    personalProjectId: input.personalProjectId ?? null, query: input.query ?? null, limit: input.limit ?? null
  });
  return { total: value.total, lessons: value.items.map(item => ({
    ...dismissalIdentity(item), reason: item.reason, lessons: item.lessons, matchedBy: item.matched_by
  })) };
}

export async function getAgentHandoff(application, input) {
  const value = await application.personal.getProjectAgentDismissal(input.personalSpaceId, input.agentId);
  return { ...dismissalIdentity(value), occupationTags: value.occupation_tags, reason: value.reason,
    lessons: value.lessons, sourceApplication: value.source_application,
    handoff: { format: 'markdown', filename: value.handoff.filename, markdown: value.handoff.markdown } };
}

// At recruitment or task start: how many lessons exist and how to ask for them,
// never their text. Null when there are none or the Provider cannot say.
export async function dismissalLessonHint(application, { personalProjectId = null, occupations = [] }) {
  const scope = { personalSpaceId: application.config.personal.spaceId,
    occupations: [...new Set(occupations.filter(Boolean))], personalProjectId };
  if (!scope.occupations.length && !personalProjectId) return null;
  try {
    const { total } = await application.personal.listProjectAgentDismissalLessons({ ...scope, limit: 0 });
    return total > 0 ? { count: total, tool: LESSON_TOOL, arguments: scope, guidance: LESSON_HINT_GUIDANCE } : null;
  } catch {
    return null;
  }
}

function dismissalReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  const bare = reason.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  if ([...reason].length < MIN_REASON_LENGTH || PLACEHOLDER_REASONS.has(bare)) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION,
      'Ask the user why this Agent is being dismissed and pass their reason; a dismissal never proceeds without one.');
  }
  if (detectSensitiveContent(reason).restricted) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'The dismissal reason contains credentials');
  }
  return reason;
}

// The handoff keeps every reviewed memory layer the Agent still owns: its
// global notes and each project it is leaving. A failed read stops the dismissal.
async function memoryLayers(application, agent) {
  if (agent.memoryScope !== 'reviewed_agent') return [];
  const personalSpaceId = application.config.personal.spaceId;
  const projects = (agent.assignments ?? []).filter(item => item.status === 'active').map(item => item.personalProjectId);
  return Promise.all([null, ...new Set(projects)].map(async (personalProjectId) => {
    const scope = { personalSpaceId, personalProjectId, agentId: agent.agentId };
    const view = scopedAgentMemoryView(await application.personal.getProjectAgentMemory({ ...scope, limit: 1 }), scope);
    return { personalProjectId, revision: view.revision, current: view.current };
  }));
}

function dismissalReceipt(value) {
  const receipt = { ...dismissalIdentity(value), status: value.replayed ? 'already_dismissed' : 'dismissed',
    lessonCount: value.lesson_count,
    handoff: { filename: value.handoff_filename, characters: value.handoff_characters, tool: 'get_agent_handoff' } };
  const number = receipt.employeeNumber ? ` (FLA ${receipt.employeeNumber})` : '';
  const scope = [receipt.occupation, ...receipt.projectIds].filter(Boolean).join(', ') || 'this space';
  return { ...receipt, summary: `${receipt.name}${number} left; ${receipt.lessonCount} lesson(s) kept for ${scope}; handoff stored.` };
}

function dismissalIdentity(value) {
  return { dismissalId: value.dismissal_id, agentId: value.agent_id, name: value.agent_name,
    employeeNumber: value.employee_number ?? null, occupation: value.occupation_role ?? null,
    projectIds: value.project_ids ?? [], dismissedAt: value.dismissed_at };
}
