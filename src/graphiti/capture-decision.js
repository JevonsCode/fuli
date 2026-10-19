import { projectCaptureReason, projectOffSince, storedProjectSettings, usesProjectModes } from './capture-project-mode.js';
import { isTemporaryProjectId } from './temporary-project-scope.js';
import { captureNotice } from '../agents/capture-notice.js';

// The one place that decides whether a write may capture (rec#5 C1). Every
// write path asks here: raw transcript, Agent conversation, task checkpoint,
// knowledge and preference evidence, Agent memory, workflow observation and
// automatic project registration. Layers combine with AND, so any layer that
// says "do not capture" stops every write; reads stay available.
//
// scope: { sourceApplication, sessionId, personalProjectId, projectPath, projectUnknown }
// - personalProjectId: the registered FULI project the write belongs to.
// - projectPath: the directory a host reported, resolved by FULI's own project
//   rules, so a worktree of a repository is that repository's project (C2-5).
// - projectUnknown: the write comes from a host that did not report its
//   directory, so FULI cannot show it is outside every project (C1-4).
// A write that names neither a project nor a directory belongs to no registered
// project, like work in an unregistered folder. When it names both, both must
// allow it. The session layer (rec#5 C3) will read sessionId; callers already
// pass it.

const ALLOWED = Object.freeze({ allowed: true, reason: null, layer: null });
const OUTSIDE_PROJECTS = Object.freeze({ personalProjectId: null });

export async function captureDecision(application, scope = {}) {
  return (await decide(application, scope)).decision;
}

// The settings and how they apply to one caller right now (rec#5 C4-4): what a
// write from this client and directory or project would be told.
export async function describeCapture(application, scope = {}) {
  const { policy, settings, project, decision } = await decide(application, scope);
  return { ...policy, current: { sourceApplication: scope.sourceApplication ?? 'other',
    personalProjectId: project?.personalProjectId ?? null, captured: decision.allowed,
    reason: decision.reason, layer: decision.layer,
    ...(decision.reason === 'project_off' ? { offSince: projectOffSince(settings, project.personalProjectId) } : {}),
    notice: captureNotice(decision) } };
}

// The scope of a write made for a FULI task context. Task entry already
// resolved its project, so a task without one is outside every project.
export function taskCaptureScope(task) {
  return { sourceApplication: task.sourceApplication, personalProjectId: task.personalProjectId ?? null,
    sessionId: task.sessionId ?? null };
}

// The result a skipped write returns. It names the decision only, never the
// content that was not recorded.
export function captureDisabled(decision) {
  return { status: 'capture_disabled', reason: decision.reason, layer: decision.layer };
}

async function decide(application, scope) {
  let policy;
  try {
    policy = application.getCapturePolicy();
  } catch {
    return { decision: denied('policy_unavailable', 'policy') };
  }
  // Settings that cannot be read or understood capture nothing.
  const settings = understoodSettings(policy);
  if (!settings) return { decision: denied('policy_unavailable', 'policy') };
  if (!policy.enabled) return { policy, decision: denied('global_off', 'global') };
  // A write that names no client comes from an unknown client, as at every
  // other FULI boundary. Settings saved before per-client capture list none.
  if ((policy.disabledSources ?? []).includes(scope.sourceApplication ?? 'other')) {
    return { policy, decision: denied('client_off', 'client') };
  }
  if (!usesProjectModes(settings)) return { policy, settings, decision: ALLOWED };
  let projects;
  try {
    projects = await writeProjects(application, scope);
  } catch {
    // The project could not be resolved, so the settings cannot be applied.
    return { policy, settings, decision: denied('policy_unavailable', 'project') };
  }
  for (const project of projects) {
    const reason = projectCaptureReason(settings, project);
    if (reason) return { policy, settings, project, decision: denied(reason, 'project') };
  }
  return { policy, settings, project: projects[0], decision: ALLOWED };
}

function understoodSettings(policy) {
  if (typeof policy?.enabled !== 'boolean'
    || (policy.disabledSources !== undefined && !Array.isArray(policy.disabledSources))) return null;
  try {
    return storedProjectSettings(policy, TypeError);
  } catch {
    return null;
  }
}

// Every project a write belongs to; null stands for one FULI cannot know.
async function writeProjects(application, { personalProjectId = null, projectPath = null, projectUnknown = false }) {
  const projects = projectUnknown ? [null] : [];
  if (personalProjectId) projects.push(registeredProject(personalProjectId));
  if (projectPath) projects.push(await directoryProject(application, projectPath));
  return projects.length ? projects : [OUTSIDE_PROJECTS];
}

async function directoryProject(application, projectPath) {
  const resolution = await application.resolveProjectPath(projectPath);
  if (resolution.status === 'matched') return registeredProject(resolution.personalProjectId);
  if (resolution.status === 'unmatched') return OUTSIDE_PROJECTS;
  // An ambiguous workspace may be any of several projects.
  return null;
}

// A temporary task project isolates work done outside every registered project.
function registeredProject(personalProjectId) {
  return isTemporaryProjectId(personalProjectId) ? OUTSIDE_PROJECTS : { personalProjectId };
}

function denied(reason, layer) {
  return { allowed: false, reason, layer };
}
