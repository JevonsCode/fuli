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
  return { personal_project_id: task.personalProjectId, first_run: state.runs.length === 0, areas, sources: state.sources,
    progress: state.progress, open: state.open, last_run: state.runs[0] ?? null,
    ...(updating ? {} : { model: { tier, advice: tierAdvice(tier) }, guidance: GUIDANCE }) };
}
