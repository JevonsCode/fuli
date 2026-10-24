import { debuglog } from 'node:util';
import { activeAgentHostClient, activeAgentHostSession, activeTaskBoundSession } from '../app/agent-request-context.js';
import { isFuliProcessSession } from '../mcp/session-id.js';

// The session layer of what FULI does for a caller (rec#5 C3 and C3b): whether
// the sessions a call speaks for may be recorded (a pause or a stop says no)
// and whether FULI may serve them at all (a stop, or a session that started
// with FULI off by default, says no to injected memory and to collaboration it
// would trigger). Both answers rest on the same identities.
//
// Only two identities can authorize a call: the session bound to its task (the
// hook issued the task's token for the session it ran in; a tool whose schema
// names no task is bound by the current token it carries, which the session
// gate resolved through the task registry) and, for an Agent's
// own MCP or CLI call, the host session its client process runs in
// (agentHostRequestContext()). A session the call merely names can only refuse
// it, never allow it. Calls outside an Agent call (hooks, the console) are
// decided by the sessions their scope names. A state that cannot be read is
// never taken for "allowed" (C3-5). Every FULI application and the capture
// window's port carry the session layer; a port composed without one (a test
// double) has no paused or stopped sessions.
//
// scope: { sourceApplication, boundSessionId, sessionId, tokenUnresolved }
// tokenUnresolved: why a task token the call carried bound it to no session
// ('task_token_not_current' or 'policy_unavailable'). It changes no decision,
// only the reason a call refused for want of a task says.

const ALLOWED = Object.freeze({ allowed: true, reason: null, layer: null });
// NODE_DEBUG=fuli-capture shows decisions made without a session layer.
const debug = debuglog('fuli-capture');

// Recording: an Agent call is recorded only when it has an authorizing
// identity, none of its identities is paused or stopped and, without a task,
// no session of its client is without capture at all: its process may have
// been started for an earlier session of the client (Claude Code keeps it
// across /clear), so its host session cannot be shown to be the current one.
export function sessionCaptureDecision(application, scope) {
  return decideSessions(application, scope, { refusal: state => offRefusal(state) ?? pausedRefusal(state),
    unattributed: sourceApplication => application.hasSessionWithoutCapture(sourceApplication)
      ? denied('policy_unavailable') : null });
}

// Serving: memory injected at task entry or read by the Agent, preferences
// restored after a compaction and collaboration started from the session.
// Decided by the call's own identities. Only a task token shows which session
// a call is for now: a host session cannot (Claude Code keeps its MCP process,
// and so its native session, across /clear; Codex gives its MCP processes no
// session at all, like Cursor and remote clients). So a call without a task
// token is refused while any session of its client is stopped or started off
// and not started since, rather than served to a session that may be that one
// (Dot's review of #251). While new sessions start off, any session may be one
// FULI could not record, so a call without a task token is refused then too.
// Calls with a task token keep one window's stop out of another (C3b-5); a
// token's session with no durable record follows the default, so it is off.
// A call whose token did not resolve is refused the same way, saying why.
export function sessionUseDecision(application, scope) {
  if (!sessionsMayBeOff(application)) return ALLOWED;
  return decideSessions(application, scope, { refusal: offRefusal,
    unattributed: sourceApplication => application.hasStoppedSession(sourceApplication)
      || !application.sessionFuliDefault().enabled ? denied(scope.tokenUnresolved ?? 'session_unattributed') : null });
}

// False when FULI is on for every session, the usual case, so a caller can
// skip finding out which sessions a call speaks for. True when the state
// cannot be read.
export function sessionsMayBeOff(application) {
  if (!application.getSessionCapturePause) return false;
  try {
    return application.hasStoppedSession();
  } catch {
    return true;
  }
}

// Whether a session of the client may record nothing (paused, stopped or
// started off), so a call's writes need to know which session they are for.
// True when the state cannot be read.
export function sessionsMayBeWithoutCapture(application, sourceApplication) {
  if (!application.getSessionCapturePause) return false;
  try {
    return application.hasSessionWithoutCapture(sourceApplication);
  } catch {
    return true;
  }
}

// Whether FULI is on for one host session and why, and the default for new
// sessions, for the session switch and its status (rec#5 C3b). Throws when
// the state cannot be read.
export function sessionFuliState(application, sessionId) {
  const state = application.getSessionCapturePause(sessionId);
  return { enabled: state.fuli.enabled, basis: state.fuli.basis, since: state.fuli.since,
    recordingPaused: state.paused, newSessions: newSessionsFuli(application) };
}

// Whether new sessions start with FULI on: 'on' or 'off'. Throws when unreadable.
export function newSessionsFuli(application) {
  return application.sessionFuliDefault().enabled ? 'on' : 'off';
}

function decideSessions(application, { boundSessionId: scopeTask = null, sessionId = null, sourceApplication: named = 'other' }, policy) {
  const host = activeAgentHostSession();
  // A tool whose schema names no task, called with a current task token: the
  // session the registry resolved for it is the call's task session too.
  const callTask = activeTaskBoundSession();
  const boundSessionId = scopeTask ?? callTask;
  // An Agent call's client is the one its process was started for, never the payload's.
  const sourceApplication = activeAgentHostClient() ?? named;
  const agentCall = host !== undefined;
  if (!agentCall && !boundSessionId && !sessionId) return ALLOWED;
  if (!application.getSessionCapturePause) {
    debug('session decision on a port without a session layer; no session is paused or stopped there');
    return ALLOWED;
  }
  // An identity FULI gave a process is no session that started under the
  // default for new sessions, so only a pause or stop said for it counts.
  const stateOf = id => {
    const state = application.getSessionCapturePause(id);
    return isFuliProcessSession(id) && state.fuli.basis === 'default' ? { ...state, stopped: false } : state;
  };
  try {
    // The call's own sessions: its task's, any it names and, without a task,
    // the host session of the call. With a task, the host session is checked
    // below even when the MCP layer filled it in as the named session.
    const own = boundSessionId ? [boundSessionId, callTask, sessionId === host ? null : sessionId] : [sessionId, host];
    for (const id of new Set(own.filter(Boolean))) {
      const refusal = policy.refusal(stateOf(id));
      if (refusal) return refusal;
    }
    // A task of another session than the call's host: the client started a new
    // session inside the MCP process (Claude Code /clear) and that process is
    // still bound to the old one. The old one's state still applies, but it is
    // not this session's (rec#5 C3, limited support).
    if (boundSessionId && host && host !== boundSessionId && policy.refusal(stateOf(host))) {
      return denied('session_binding_stale');
    }
    if (!agentCall) return ALLOWED;
    if (!boundSessionId && !host) return denied('policy_unavailable');
    return (!boundSessionId && policy.unattributed(sourceApplication, host)) || ALLOWED;
  } catch {
    return denied('policy_unavailable');
  }
}

// A stop said in the session or a session that started it, the default the
// session started under, or a start whose default could not be saved.
function offRefusal(state) {
  if (!state.stopped) return null;
  if (state.fuli.basis === 'default') return denied('session_not_started');
  if (state.fuli.basis === 'start_unsaved') return denied('session_start_unsaved');
  return { ...denied('session_stopped'), since: state.fuli.since };
}

function pausedRefusal(state) {
  return state.paused ? { ...denied('session_paused'), since: state.since } : null;
}

function denied(reason) {
  return { allowed: false, reason, layer: 'session' };
}
