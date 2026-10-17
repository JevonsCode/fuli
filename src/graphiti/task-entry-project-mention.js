import { createHash } from 'node:crypto';

const NEW_PROJECT = /^\s*(?:新项目|new project)\s*[:：]\s*([^\n\r,，。]{1,80})/i;
const NAME_END = /^(?:$|[\s:：,，。.、!！?？])/;

// Deterministic, model-free project choice from the opening of a task prompt:
// "<project name> ..." selects that registered project, and "新项目：<name>"
// (or "new project: <name>") creates it once. Session fallbacks never match.
export async function projectNamedInPrompt(application, taskPrompt) {
  if (typeof taskPrompt !== 'string' || !taskPrompt.trim()) return null;
  const spaceId = application.config.personal.spaceId;
  const projects = (await application.personal.listPersonalProjects(spaceId)).filter(nameable);
  const requested = NEW_PROJECT.exec(taskPrompt)?.[1]?.trim();
  if (requested) {
    const existing = projects.find(project => sameName(project, requested));
    if (existing) return { personalProjectId: existing.project_id, basis: 'named_in_prompt' };
    const projectId = projectIdFor(requested);
    await application.upsertPersonalProject({ personalSpaceId: spaceId, projectId, createOnly: true,
      profile: { name: requested, lifecycle: 'active' } });
    return { personalProjectId: projectId, basis: 'created_from_prompt' };
  }
  const opening = taskPrompt.trimStart().toLowerCase();
  const named = projects
    .flatMap(project => names(project).map(name => ({ project, name: name.toLowerCase() })))
    .filter(({ name }) => opening.startsWith(name) && NAME_END.test(opening.slice(name.length)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return named ? { personalProjectId: named.project.project_id, basis: 'named_in_prompt' } : null;
}

// Legacy per-session fallbacks and task-scoped projects are containers, not
// projects a person names; they stay out of name matching.
function nameable(project) {
  return project?.scope_type !== 'temporary' && !String(project?.project_id ?? '').startsWith('conversation-');
}

function names(project) {
  return [...new Set([project.project_id, project.profile?.name].filter(Boolean).map(String))];
}

function sameName(project, name) {
  return names(project).some(value => value.toLowerCase() === name.toLowerCase());
}

function projectIdFor(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[\x20-\x7e]+$/.test(name) && slug.length >= 2 ? slug.slice(0, 64)
    : `project-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`;
}
