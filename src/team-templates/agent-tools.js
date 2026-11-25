import { activeAgentHostClient, activeAgentHostSession } from '../app/agent-request-context.js';
import { ApplicationError, InvalidInputError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';
import { requiredString } from '../validation/values.js';
import { exportProjectTeamTemplate } from './export.js';
import { importProjectTeam } from './import.js';
import { assertConfirmed, planTeamTemplateImport, previewView } from './plan.js';
import { requireTeamTemplateProject } from './project.js';
import { teamTemplateDraftView } from './receipts.js';

const PROJECT_ID_MAX = 256;
const DRAFT_LIMIT = 20;
const DRAFT_LIMIT_MAX = 50;

// The Agent side of portable project team templates: export one team, preview
// an import against one explicitly selected project, apply a preview the
// person confirmed, and read the drafts an import left in the target. The
// application composes these four; every handler stays one capability.
export const TEAM_TEMPLATE_HANDLERS = Object.freeze({
  export_project_team_template: (app, input) => app.exportProjectTeamTemplate(input),
  preview_project_team_template_import: (app, input) => app.previewProjectTeamTemplateImport(input),
  import_project_team_template: (app, input) => app.importProjectTeamTemplate(input),
  read_project_team_template: (app, input) => app.readProjectTeamTemplate(input)
});

export async function exportProjectTeamTemplateTool(app, input) {
  scoped(app, input);
  await requireTaskProject(app, input, requiredString(input?.personalProjectId, 'personalProjectId', PROJECT_ID_MAX));
  return exportProjectTeamTemplate(app, input);
}

export async function previewProjectTeamTemplateImportTool(app, input) {
  scoped(app, input);
  await requireTaskProject(app, input, requiredString(input?.personalProjectId, 'personalProjectId', PROJECT_ID_MAX));
  return previewView(await planTeamTemplateImport(app, withTemplate(app, input)));
}

export async function importProjectTeamTemplateTool(app, input) {
  scoped(app, input);
  await requireTaskProject(app, input, requiredString(input?.personalProjectId, 'personalProjectId', PROJECT_ID_MAX));
  const resolved = withTemplate(app, input);
  const plan = await planTeamTemplateImport(app, resolved);
  // A conflict plan writes nothing; the preview already says what to resolve.
  if (plan.status !== 'ready') return previewView(plan);
  assertConfirmed(input, plan);
  return importProjectTeam(app, plan, resolved, {
    sourceApplication: activeAgentHostClient() ?? 'other',
    sourceSessionId: activeAgentHostSession() ?? null
  });
}

// The drafts a target project received from an import: its acceptance checks
// and recurring blueprints, readable in a new session after a restart. They
// are drafts the target team confirms or enables itself; reading never turns
// one into memory, a schedule or a routing rule.
export async function readProjectTeamTemplateTool(app, input) {
  scoped(app, input);
  const personalProjectId = requiredString(input?.personalProjectId, 'personalProjectId', PROJECT_ID_MAX);
  await requireTaskProject(app, input, personalProjectId);
  await requireTeamTemplateProject(app, input.personalSpaceId, personalProjectId);
  if (!app.teamTemplateReceipts?.read) {
    throw new ApplicationError('team_template_receipts_unavailable',
      'This FULI cannot read imported team template drafts.', { status: 503 });
  }
  const limit = Number.isInteger(input?.limit)
    ? Math.min(Math.max(input.limit, 1), DRAFT_LIMIT_MAX) : DRAFT_LIMIT;
  let receipt = null;
  try {
    receipt = app.teamTemplateReceipts.read(input.personalSpaceId, personalProjectId);
  } catch {
    receipt = null;
  }
  return teamTemplateDraftView(receipt, { limit });
}

// A large template may come back as a short local reference this computer
// keeps; exactly one of the two names the team. The reference is read for the
// active space only, so it cannot reach a template another space exported.
function withTemplate(app, input) {
  const inline = input?.template != null;
  const referenced = input?.templateRef != null;
  if (inline === referenced) {
    throw new InvalidInputError('Provide exactly one of template or templateRef');
  }
  if (inline) return input;
  if (!app.teamTemplateRefs?.get) {
    throw new ApplicationError('team_template_reference_unavailable',
      'This FULI cannot read a local template reference. Pass the template itself. Nothing was written.', { status: 422 });
  }
  return { ...input, template: app.teamTemplateRefs.get(input.templateRef, { personalSpaceId: input.personalSpaceId }) };
}

// The task an Agent call's token names must be bound to the exact project the
// tool is about, and the token is resolved before any provider read, local
// reference lookup or write. A task in another project is refused even in the
// same space: one space can own both the source and the target, and an Agent
// working in one must not move the other's team. A cross-project transfer is
// two independently authorized calls: export under the source task, then
// preview/import/read under the destination task. No FLA or lead is required,
// so an empty authorized target still accepts its team.
async function requireTaskProject(app, input, personalProjectId) {
  const task = await callingTask(app, input);
  if (!task) {
    throw new InvalidInputError('This taskContextToken is unknown or expired; begin a FULI task in the project first');
  }
  if (!task.personalProjectId || task.personalProjectId !== personalProjectId) {
    throw new ApplicationError('project_mismatch',
      `This task works in ${task.personalProjectId ? `project ${task.personalProjectId}` : 'no project'}, not ${personalProjectId}. `
      + 'Open the AI client in that project\'s folder and ask again; a team template never moves another project\'s team.',
      { status: 409 });
  }
  return task;
}

// The active personal space only; the source client and session are the
// call's own, never a payload field.
function scoped(app, input) {
  const requested = input?.personalSpaceId;
  if (typeof requested !== 'string' || !requested) {
    throw new InvalidInputError('personalSpaceId is required');
  }
  const active = app.config?.personal?.spaceId;
  if (active && requested !== active) {
    throw new ApplicationError('scope_mismatch', 'Use the active personal space', { status: 403 });
  }
  return input;
}
