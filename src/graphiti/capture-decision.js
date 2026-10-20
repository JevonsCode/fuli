import { AsyncLocalStorage } from 'node:async_hooks';
import { debuglog } from 'node:util';
import { activeAgentHostSession } from '../app/agent-request-context.js';
import { projectCaptureReason, projectOffSince, storedProjectSettings, usesProjectModes } from './capture-project-mode.js';
import { isTemporaryProjectId } from './temporary-project-scope.js';
import { captureNotice } from './capture-notice.js';

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
// allow it.
// - boundSessionId: the session the write's task was bound to by its hook.
// - sessionId: a session the write names (a hook's own, or one a model sent).
//   A paused session, or one started by a paused session, records nothing from
//   the pause on (rec#5 C3); see sessionDecision() for which sessions authorize.

const ALLOWED = Object.freeze({ allowed: true, reason: null, layer: null });
// NODE_DEBUG=fuli-capture shows decisions made without a session layer.
const debug = debuglog('fuli-capture');
const OUTSIDE_PROJECTS = Object.freeze({ personalProjectId: null });

// Directory lookups shared by the decisions of one hook run or tool request:
// however many writes a turn asks about, its directory is resolved once. A
// later request looks again, so a project registered in between counts.
const requestLookups = new AsyncLocalStorage();

export function withCaptureLookups(operation) {
  return requestLookups.getStore() ? operation() : requestLookups.run(new Map(), operation);
}

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
    ...(decision.since ? { pausedSince: decision.since } : {}),
    notice: captureNotice(decision.reason, decision.since) } };
}

// The scope of a write made for a FULI task context. Task entry already
// resolved its project, so a task without one is outside every project.
export function taskCaptureScope(task) {
  return { sourceApplication: task.sourceApplication, personalProjectId: task.personalProjectId ?? null,
    boundSessionId: task.sessionId ?? null };
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
  let project = null;
  if (usesProjectModes(settings)) {
    let projects;
    try {
      projects = await writeProjects(application, scope);
    } catch {
      // The project could not be resolved, so the settings cannot be applied.
      return { policy, settings, decision: denied('policy_unavailable', 'project') };
    }
    for (const candidate of projects) {
      const reason = projectCaptureReason(settings, candidate);
      if (reason) return { policy, settings, project: candidate, decision: denied(reason, 'project') };
    }
    project = projects[0];
  }
  return { policy, settings, project, decision: sessionDecision(application, scope) };
}

// The session layer (rec#5 C3). Only two identities can authorize a write:
// the session bound to the write's task (taskCaptureScope(): the hook issued
// its token for the session it ran in) and, for an Agent's own MCP or CLI
// call, the host session its client process runs in (agentHostRequestContext()).
// A session the write merely names can only refuse it, never allow it. An
// Agent call is recorded only when it has an authorizing identity, none of
// its identities is paused and, without a task, no session of its client is
// paused at all: its process may have been started for an earlier session of
// the client (Claude Code keeps it across /clear), so its host session cannot
// be shown to be the current one. Writes outside an Agent call (hooks, the
// console) are decided by the sessions their scope names. A pause that cannot
// be read is never taken for "not paused" (C3-5). Every FULI application and
// the capture window's port carry the session layer; a port composed without
// one (a test double) has no paused sessions.
function sessionDecision(application, { boundSessionId = null, sessionId = null, sourceApplication = 'other' }) {
  const host = activeAgentHostSession();
  const agentCall = host !== undefined;
  if (!agentCall && !boundSessionId && !sessionId) return ALLOWED;
  if (!application.getSessionCapturePause) {
    debug('capture decision on a port without a session layer; no session is paused there');
    return ALLOWED;
  }
  try {
    for (const id of new Set([boundSessionId, host, sessionId].filter(Boolean))) {
      const session = application.getSessionCapturePause(id);
      if (session.paused) return { ...denied('session_paused', 'session'), since: session.since };
    }
    if (!agentCall) return ALLOWED;
    if (!boundSessionId && !host) return denied('policy_unavailable', 'session');
    if (!boundSessionId && application.hasPausedCaptureSession(sourceApplication)) {
      return denied('policy_unavailable', 'session');
    }
    return ALLOWED;
  } catch {
    return denied('policy_unavailable', 'session');
  }
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
  const resolution = await sharedLookup(application, projectPath);
  if (resolution.status === 'matched') return registeredProject(resolution.personalProjectId);
  if (resolution.status === 'unmatched') return OUTSIDE_PROJECTS;
  // An ambiguous workspace may be any of several projects.
  return null;
}

// Settings in the default mode never get here, so they never look a directory up.
// Lookups are kept per configuration, which an application shares with the
// capture window's port for it.
function sharedLookup(application, projectPath) {
  const lookups = requestLookups.getStore();
  if (!lookups || !application.config) return application.resolveProjectPath(projectPath);
  if (!lookups.has(application.config)) lookups.set(application.config, new Map());
  const resolved = lookups.get(application.config);
  if (!resolved.has(projectPath)) resolved.set(projectPath, application.resolveProjectPath(projectPath));
  return resolved.get(projectPath);
}

// A temporary task project isolates work done outside every registered project.
function registeredProject(personalProjectId) {
  return isTemporaryProjectId(personalProjectId) ? OUTSIDE_PROJECTS : { personalProjectId };
}

function denied(reason, layer) {
  return { allowed: false, reason, layer };
}

// The settings every layer of the decision reads for one host session, as one
// comparable value; null when it cannot be read. Transcript turns written
// while it changed cannot be attributed to one decision, so they are not
// imported (conversations/transcript-capture-gap.js). The session layer adds
// its own generation only when the session has a pause record, so a pause or
// resume in one session never moves the value of another (C3-3).
export function captureSettingsVersion(application, sessionId = null) {
  try {
    const settings = application.getCapturePolicyVersion() ?? null;
    const session = sessionId && application.getSessionCapturePause
      ? application.getSessionCapturePause(sessionId).version : null;
    return settings === null || !session ? settings : `${settings}|session:${session}`;
  } catch {
    return null;
  }
}

// Moves the settings version without a settings change, so every process
// treats what it last recorded as stale: the fallback when a session's own
// record of a denial cannot be kept. False when that cannot be saved either.
export function advanceCaptureSettingsVersion(application) {
  try {
    application.advanceCapturePolicyVersion();
    return true;
  } catch {
    return false;
  }
}
