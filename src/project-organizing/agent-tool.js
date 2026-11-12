import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { modelTier, tierAdvice } from './model-tiers.js';
import { CONSENT_SOURCES } from './port.js';

// The organize_project Agent tool (rec#114): read how well the project is
// known and what earlier runs did, or record what this run settled. The
// project is the task's own, so an Agent never names one. How to do the work
// is in skills/operating-fuli (Organising a project). Its preferences action
// (rec#121) reads the person's preferences instead and needs no project.

const GUIDANCE = 'Follow skills/operating-fuli (Organising a project). Work by yourself; do not interview the person. '
  + 'Material the person named (a folder, documents, links, another knowledge base) is read with your own tools and recorded as named_material. '
  + `Ask once before reading ${CONSENT_SOURCES.join(', ')} and record the answer in sources (read or declined). `
  + 'Save what you add as pending knowledge with checkpoint_task_knowledge. What you are unsure of goes in one short list '
  + 'at the end, each answerable 是 / 否 / 其他; the person may skip it. End with update: the areas settled and run with your counts.';
// With repeated_preference_check: a preference this project shares with another is asked about once, on that list.
const REPEATED_GUIDANCE = ' Run repeated_preference_check once with the subject of this project\'s preferences as query; '
  + 'each candidate found is one line on that list: 「偏好 X 在项目 A、B 里都有，升级成全局吗？」.';
// 「整理我的偏好」 (rec#121): the person's preferences, whatever folder the session is in.
const PREFERENCES_GUIDANCE = 'Follow skills/operating-fuli (Organising preferences). Read every page (offset: next_offset, until none) before proposing. '
  + 'duplicates (first page only) are copies FULI\'s duplicate rules call one; keep is the copy that stays. Propose in one list: copies to retire, '
  + 'preferences to move between global and a project, stale or contradicting ones to retire, pending ones to confirm. '
  + 'Change only what the person says yes to in this chat: retire or reword with revise_personal_knowledge '
  + '(invalidate, then link_replacement to the kept copy; mark_outdated; update). Confirming and moving scope are the person\'s '
  + 'decisions: relay their words with run_delegated_action (POST /api/knowledge/batch-confirmation, '
  + 'POST /api/knowledge/:itemKind/:itemId/preference-scope). Permanent deletion stays in the console.';
const PREFERENCES_REPEATED_GUIDANCE = ' For a subject listed in several projects, run repeated_preference_check with it as query.';
// The tool takes at most this many projects.
const MAX_CHECKED_PROJECTS = 32;

// The read call that finds preferences shared across the person's projects
// (this project and the others, when one is given); null with fewer than two
// projects, or when the projects cannot be listed.
async function repeatedPreferenceCheck(application, spaceId, projectId = null) {
  let projects;
  try {
    projects = await application.personal.listPersonalProjects(spaceId);
  } catch {
    return null;
  }
  const others = projects.map(project => project.project_id).filter(id => id && id !== projectId);
  const checked = [projectId, ...others].filter(Boolean).slice(0, MAX_CHECKED_PROJECTS);
  if (checked.length < 2) return null;
  return { tool: 'discover_personal_global_preference_candidates',
    arguments: { personalSpaceId: spaceId, personalProjectIds: checked } };
}

// A page of the person's preferences; the first page (the only one with the copies
// the duplicate rules call one) also says how to apply what the person approves.
async function organizePreferences(application, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InvalidInputError('offset is a whole number of 0 or more: pass the next_offset of the page before');
  }
  const spaceId = application.config.personal.spaceId;
  const page = await application.personal.readPreferenceOrganizing({ personalSpaceId: spaceId, offset });
  if (offset) return page;
  const check = await repeatedPreferenceCheck(application, spaceId);
  return { ...page, guidance: PREFERENCES_GUIDANCE + (check ? PREFERENCES_REPEATED_GUIDANCE : ''),
    ...(check ? { repeated_preference_check: check } : {}) };
}

export async function organizeProject(application, input = {}) {
  if (input.action === 'preferences') return organizePreferences(application, input.offset);
  if (!application.projectOrganizing) {
    throw new ApplicationError('project_organizing_unavailable', 'Organising a project needs a local FULI installation');
  }
  const task = await application.taskContextRegistry.context(input.taskContextToken, input.sourceApplication);
  if (!task?.personalProjectId) {
    throw new ApplicationError('project_unresolved', 'This task belongs to no project; run it from the project folder.', { status: 409 });
  }
  // A sentence started from the console names its project. A session opened in another
  // project's folder must not organise that one under this name.
  if (input.personalProjectId && input.personalProjectId !== task.personalProjectId) {
    throw new ApplicationError('project_mismatch',
      `This session works in project ${task.personalProjectId}, not ${input.personalProjectId}. Open the AI client in that project's folder and say it again.`,
      { status: 409 });
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
