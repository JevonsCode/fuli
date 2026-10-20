import { debuglog } from 'node:util';
import { activeAgentHostSession } from '../app/agent-request-context.js';

// The session layer of what FULI does for a caller (rec#5 C3 and C3b): whether
// the sessions a call speaks for may be recorded (a pause or a stop says no)
// and whether FULI may serve them at all (a stop, or a session that started
// with FULI off by default, says no to injected memory and to collaboration it
// would trigger). Both answers rest on the same identities.
//
// Only two identities can authorize a call: the session bound to its task (the
// hook issued the task's token for the session it ran in) and, for an Agent's
// own MCP or CLI call, the host session its client process runs in
// (agentHostRequestContext()). A session the call merely names can only refuse
// it, never allow it. Calls outside an Agent call (hooks, the console) are
// decided by the sessions their scope names. A state that cannot be read is
// never taken for "allowed" (C3-5). Every FULI application and the capture
// window's port carry the session layer; a port composed without one (a test
// double) has no paused or stopped sessions.
//
// scope: { sourceApplication, boundSessionId, sessionId }

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
    anyRefused: sourceApplication => application.hasSessionWithoutCapture(sourceApplication) });
}

// Serving: memory injected at task entry, preferences restored after a
// compaction and collaboration started from the session. Decided by the call's
// own identities only, so a stop in one window never changes another (C3b-5);
// see the /clear limit in sessionCaptureDecision().
export function sessionUseDecision(application, scope) {
  if (!sessionsMayBeOff(application)) return ALLOWED;
  return decideSessions(application, scope, { refusal: offRefusal, anyRefused: null });
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

function decideSessions(application, { boundSessionId = null, sessionId = null, sourceApplication = 'other' }, policy) {
  const host = activeAgentHostSession();
  const agentCall = host !== undefined;
  if (!agentCall && !boundSessionId && !sessionId) return ALLOWED;
  if (!application.getSessionCapturePause) {
    debug('session decision on a port without a session layer; no session is paused or stopped there');
    return ALLOWED;
  }
  try {
    // The call's own sessions: its task's, any it names and, without a task,
    // the host session of the call. With a task, the host session is checked
    // below even when the MCP layer filled it in as the named session.
    const own = boundSessionId ? [boundSessionId, sessionId === host ? null : sessionId] : [sessionId, host];
    for (const id of new Set(own.filter(Boolean))) {
      const refusal = policy.refusal(application.getSessionCapturePause(id));
      if (refusal) return refusal;
    }
    // A task of another session than the call's host: the client started a new
    // session inside the MCP process (Claude Code /clear) and that process is
    // still bound to the old one. The old one's state still applies, but it is
    // not this session's (rec#5 C3, limited support).
    if (boundSessionId && host && host !== boundSessionId && policy.refusal(application.getSessionCapturePause(host))) {
      return denied('session_binding_stale');
    }
    if (!agentCall) return ALLOWED;
    if (!boundSessionId && !host) return denied('policy_unavailable');
    if (!boundSessionId && policy.anyRefused?.(sourceApplication)) return denied('policy_unavailable');
    return ALLOWED;
  } catch {
    return denied('policy_unavailable');
  }
}

// A stop said in the session or a session that started it, or the default the
// session started under.
function offRefusal(state) {
  if (!state.stopped) return null;
  return state.fuli.basis === 'default' ? denied('session_not_started')
    : { ...denied('session_stopped'), since: state.fuli.since };
}

function pausedRefusal(state) {
  return state.paused ? { ...denied('session_paused'), since: state.since } : null;
}

function denied(reason) {
  return { allowed: false, reason, layer: 'session' };
}
