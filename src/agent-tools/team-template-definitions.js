import { boundedString, objectSchema } from './schema.js';
import { id } from './graph-tool-fields.js';

// The task the call acts for. Its bound project must be the project named
// here, so one Agent cannot move a team it is not working in. 256 bytes, the
// same bound every task-token field uses.
const token = boundedString(256);

// A template describes a team, never its memory: role identities, what each is
// responsible for, how they report, the procedures the team confirmed, the
// checks it learned and its recurring work lines. It is versioned and digested
// by schema.js, so the schema here only says "an object this FULI exported".
const teamTemplate = {
  type: 'object',
  additionalProperties: true,
  description: 'The template object exactly as export_project_team_template returned it; do not edit it.'
};
const templateRef = {
  ...boundedString(64),
  description: 'A short local reference export_project_team_template returned instead of a template too large '
    + 'for one answer; pass it instead of template on the same computer.'
};
const roleAgentIds = {
  type: 'object',
  additionalProperties: { type: 'string', minLength: 1, maxLength: 256 },
  description: 'Optional roleKey to an existing Agent ID of this space with that occupation.'
};
const target = {
  personalSpaceId: id,
  personalProjectId: id
};

// Export, preview and apply. The person's destination-bound instruction is
// enough to apply a ready plan; a supplied confirmationDigest additionally
// binds the apply to the exact template, project and role mapping previewed.
export const TEAM_TEMPLATE_DEFINITIONS = [
  {
    name: 'export_project_team_template',
    title: 'READ · Export a project team template',
    description: 'Export this project\'s team as a portable, versioned template: role identities, responsibilities, reporting, sub-teams, active workflows, learned acceptance checks and recurring work lines. Free text that names a secret, a host path, a private link or a source identity is redacted and counted, never repeated. Never exports chats, memory, personal data or access. Reads only, except a short local reference when the template is too large for one answer. The taskContextToken must be a task in this project.',
    inputSchema: objectSchema({ ...target, taskContextToken: token }, ['personalSpaceId', 'personalProjectId', 'taskContextToken'])
  },
  {
    name: 'preview_project_team_template_import',
    title: 'READ · Preview importing a team template',
    description: 'Preview importing a team template into one authorized project: maps each role to an existing or deterministic Agent, checks its lead, members, sub-teams, workflows and recurring work, and writes nothing. A target team that already differs is reported as a conflict; an existing workflow or recurring line is kept. Call it before importing, then import when the person named this destination. The taskContextToken must be a task in this destination project.',
    inputSchema: objectSchema({ ...target, taskContextToken: token, template: teamTemplate, templateRef, roleAgentIds },
      ['personalSpaceId', 'personalProjectId', 'taskContextToken'])
  },
  {
    name: 'import_project_team_template',
    title: 'WRITE · Import a confirmed team template',
    description: 'Apply a previewed team template to the same project. Reuses or creates Agents with deterministic IDs, never replaces a different working team or a locally changed workflow, proposes its workflows (learned ones wait for this project\'s person), and keeps its acceptance checks and recurring blueprints as drafts. The person\'s destination-bound instruction is enough; a stale confirmationDigest is refused. A retry resumes without duplicates; a partial result lists what was saved. The taskContextToken must be a task in this destination project.',
    inputSchema: objectSchema({ ...target, taskContextToken: token, template: teamTemplate, templateRef, roleAgentIds,
      confirmationDigest: boundedString(64) },
    ['personalSpaceId', 'personalProjectId', 'taskContextToken'])
  },
  {
    name: 'read_project_team_template',
    title: 'READ · Read a project team template draft',
    description: 'Read the acceptance checks and recurring blueprints a team template import left in this project, in a new session after a restart. They are drafts: the target person confirms a check or enables a line, and nothing here runs or routes work. get_project_team names the draft with readWith when one exists. The taskContextToken must be a task in this project.',
    inputSchema: objectSchema({ ...target, taskContextToken: token, limit: draftLimit() },
      ['personalSpaceId', 'personalProjectId', 'taskContextToken'])
  }
];

// At most 50 checks or blueprints are ever kept, so one answer reads them all.
function draftLimit() {
  return { type: 'integer', minimum: 1, maximum: 50,
    description: 'How many draft checks and blueprints to return; default 20, maximum 50.' };
}
