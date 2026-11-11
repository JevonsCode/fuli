import { ApplicationError } from '../app/application-error.js';
import { modelTier, tierAdvice } from './model-tiers.js';
import { CONSENT_SOURCES } from './port.js';

// The organize_project Agent tool (rec#114): read how well the project is
// known and what earlier runs did, or record what this run settled. The
// project is the task's own, so an Agent never names one. How to do the work
// is in skills/operating-fuli (Organising a project).

const GUIDANCE = 'Follow skills/operating-fuli (Organising a project). Work by yourself; do not interview the person. '
  + `Ask once before reading ${CONSENT_SOURCES.join(', ')} and record the answer in sources (read or declined). `
  + 'Save what you add as pending knowledge with checkpoint_task_knowledge. What you are unsure of goes in one short list '
  + 'at the end, each answerable 是 / 否 / 其他; the person may skip it. End with update: the areas settled and run with your counts.';
// With repeated_preference_check: a preference this project shares with another is asked about once, on that list.
const REPEATED_GUIDANCE = ' Run repeated_preference_check once with the subject of this project\'s preferences as query; '
  + 'each candidate found is one line on that list: 「偏好 X 在项目 A、B 里都有，升级成全局吗？」.';
// The tool takes at most this many projects.
const MAX_CHECKED_PROJECTS = 32;

// The read call that finds preferences this project shares with the person's
// other projects; null with no other project, or when the projects cannot be listed.
async function repeatedPreferenceCheck(application, spaceId, projectId) {
  let projects;
  try {
    projects = await application.personal.listPersonalProjects(spaceId);
  } catch {
    return null;
  }
  const others = projects.map(project => project.project_id).filter(id => id && id !== projectId);
  if (!others.length) return null;
  return { tool: 'discover_personal_global_preference_candidates',
    arguments: { personalSpaceId: spaceId, personalProjectIds: [projectId, ...others].slice(0, MAX_CHECKED_PROJECTS) } };
}

export async function organizeProject(application, input = {}) {
  if (!application.projectOrganizing) {
    throw new ApplicationError('project_organizing_unavailable', 'Organising a project needs a local FULI installation');
  }
  const task = await application.taskContextRegistry.context(input.taskContextToken, input.sourceApplication);
  if (!task?.personalProjectId) {
    throw new ApplicationError('project_unresolved', 'This task belongs to no project; run it from the project folder.', { status: 409 });
  }
  const spaceId = application.config.personal.spaceId;
  const updating = input.action === 'update';
  const state = updating
    ? application.projectOrganizing.update(spaceId, task.personalProjectId, { areas: input.areas, sources: input.sources, run: input.run })
    : application.projectOrganizing.view(spaceId, task.personalProjectId);
  // The area names come with a read; an update answers ids and states only.
  const areas = state.areas.map(({ id, zh, status, note }) => ({ id, ...(updating ? {} : { name: zh }), status, ...(note ? { note } : {}) }));
  const tier = modelTier(input.model);
  const check = updating || !application.personal?.listPersonalProjects ? null
    : await repeatedPreferenceCheck(application, spaceId, task.personalProjectId);
  return { personal_project_id: task.personalProjectId, first_run: state.runs.length === 0, areas, sources: state.sources,
    progress: state.progress, open: state.open, last_run: state.runs[0] ?? null,
    ...(updating ? {} : { model: { tier, advice: tierAdvice(tier) }, guidance: GUIDANCE + (check ? REPEATED_GUIDANCE : ''),
      ...(check ? { repeated_preference_check: check } : {}) }) };
}
