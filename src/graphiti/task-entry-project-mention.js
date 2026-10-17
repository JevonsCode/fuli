import { createHash } from 'node:crypto';

const NEW_PROJECT = /^\s*(?:新项目|new project)\s*[:：]\s*([^\n\r,，。]{1,80})/i;
const NAME_END = /^(?:$|[\s:：,，。.、!！?？])/;
const PURPOSE_LIMIT = 240;

// Deterministic, model-free project choice from the opening of a task prompt:
// "<project name> ..." selects that registered project, and "新项目：<name>"
// (or "new project: <name>") creates it once. Session fallbacks never match,
// and a name shared by several projects is ambiguous rather than first-wins.
export async function projectNamedInPrompt(application, taskPrompt) {
  if (typeof taskPrompt !== 'string' || !taskPrompt.trim()) return null;
  const spaceId = application.config.personal.spaceId;
  const all = await application.personal.listPersonalProjects(spaceId);
  const projects = all.filter(nameable);
  const requested = NEW_PROJECT.exec(taskPrompt)?.[1]?.trim();
  if (requested) {
    const existing = projects.filter(project => sameName(project, requested));
    if (existing.length) return choice(existing, 'named_in_prompt');
    // The brief is the user's own opening line, so its source is the prompt.
    return createNamedProject(application, spaceId, all, requested,
      taskPrompt.trim().split(/\r?\n/, 1)[0].slice(0, PURPOSE_LIMIT));
  }
  const opening = taskPrompt.trimStart().toLowerCase();
  const matches = projects
    .flatMap(project => names(project).map(name => ({ project, name: name.toLowerCase() })))
    .filter(({ name }) => opening.startsWith(name) && NAME_END.test(opening.slice(name.length)));
  const longest = Math.max(0, ...matches.map(({ name }) => name.length));
  return choice(matches.filter(({ name }) => name.length === longest).map(({ project }) => project),
    'named_in_prompt');
}

// Shared by Jefa's triage: the same name rules decide which project a label means.
export async function projectByName(application, name) {
  const projects = (await application.personal.listPersonalProjects(application.config.personal.spaceId))
    .filter(nameable);
  return choice(projects.filter(project => sameName(project, name)), 'named_by_triage');
}

export async function createProjectNamed(application, name, purpose) {
  const spaceId = application.config.personal.spaceId;
  return createNamedProject(application, spaceId,
    await application.personal.listPersonalProjects(spaceId), name, purpose);
}

// Display names only, for a compact triage candidate list.
export async function projectNames(application, limit) {
  return (await application.personal.listPersonalProjects(application.config.personal.spaceId))
    .filter(nameable).map(project => project.profile?.name || project.project_id).slice(0, limit);
}

function choice(projects, basis) {
  const ids = [...new Set(projects.map(project => project.project_id))];
  if (ids.length > 1) return { ambiguous: true, basis, candidateCount: ids.length };
  return ids.length ? { personalProjectId: ids[0], basis } : null;
}

// The readable slug is used while it is free; a different name that slugs the
// same way gets a name-derived suffix. A concurrent create of the same name
// is the same project, so a create-only conflict re-reads before giving up.
async function createNamedProject(application, spaceId, all, name, purpose) {
  const taken = new Map(all.map(project => [project.project_id, project]));
  const owns = project => nameable(project) && sameName(project, name);
  const readable = readableId(name);
  for (const projectId of [readable, hashedId(name, readable)].filter(Boolean)) {
    if (taken.has(projectId)) {
      if (owns(taken.get(projectId))) return { personalProjectId: projectId, basis: 'named_in_prompt' };
      continue;
    }
    try {
      await application.upsertPersonalProject({ personalSpaceId: spaceId, projectId, createOnly: true,
        profile: { name, purpose, lifecycle: 'active' } });
      return { personalProjectId: projectId, basis: 'created_from_prompt' };
    } catch (error) {
      if (error?.status !== 409) throw error;
      const current = await application.personal.getPersonalProject(spaceId, projectId);
      if (owns(current)) return { personalProjectId: projectId, basis: 'named_in_prompt' };
    }
  }
  throw Object.assign(new Error('No free project ID for this name'), { status: 409 });
}

// Legacy per-session fallbacks, task-scoped and archived projects are not
// projects a person names now; they stay out of name matching.
function nameable(project) {
  return project?.scope_type !== 'temporary' && project?.profile?.lifecycle !== 'archived'
    && !String(project?.project_id ?? '').startsWith('conversation-');
}

function names(project) {
  return [...new Set([project?.project_id, project?.profile?.name].filter(Boolean).map(String))];
}

function sameName(project, name) {
  return names(project).some(value => value.toLowerCase() === name.toLowerCase());
}

function readableId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return /^[\x20-\x7e]+$/.test(name) && slug.length >= 2 ? slug : null;
}

function hashedId(name, readable) {
  const digest = createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 12);
  return `${readable ?? 'project'}-${digest}`;
}
