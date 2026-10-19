// The one place that decides whether a write may capture (rec#5 C1). Every
// write path asks here: raw transcript, Agent conversation, task checkpoint,
// knowledge and preference evidence, Agent memory, workflow observation and
// automatic project registration. Layers combine with AND, so any layer that
// says "do not capture" stops every write; reads stay available.
//
// scope: { sourceApplication, projectPath, personalProjectId, sessionId }.
// Only the global and client layers have stored settings today. The project
// and session layers (rec#5 C2, C3) will read the rest of the scope, so callers
// already pass what they know and do not change when those layers land.

const ALLOWED = Object.freeze({ allowed: true, reason: null, layer: null });

export function captureDecision(application, scope = {}) {
  let policy;
  try {
    policy = application.getCapturePolicy();
  } catch {
    return denied('policy_unavailable', 'policy');
  }
  // Settings that cannot be read or understood capture nothing.
  if (typeof policy?.enabled !== 'boolean'
    || (policy.disabledSources !== undefined && !Array.isArray(policy.disabledSources))) {
    return denied('policy_unavailable', 'policy');
  }
  if (!policy.enabled) return denied('global_off', 'global');
  // A write that names no client comes from an unknown client, as at every
  // other FULI boundary. Settings saved before per-client capture list none.
  if ((policy.disabledSources ?? []).includes(scope.sourceApplication ?? 'other')) {
    return denied('client_off', 'client');
  }
  return ALLOWED;
}

// The scope of a write made for a FULI task context.
export function taskCaptureScope(task) {
  return { sourceApplication: task.sourceApplication, personalProjectId: task.personalProjectId ?? null,
    sessionId: task.sessionId ?? null };
}

// The result a skipped write returns. It names the decision only, never the
// content that was not recorded.
export function captureDisabled(decision) {
  return { status: 'capture_disabled', reason: decision.reason, layer: decision.layer };
}

function denied(reason, layer) {
  return { allowed: false, reason, layer };
}

// The settings every layer of the decision reads, as one comparable value;
// null when it cannot be read. Transcript turns written while it changed
// cannot be attributed to one decision, so they are not imported
// (conversations/transcript-capture-gap.js). A layer with its own stored
// state (project modes, session pause) belongs in this value too.
export function captureSettingsVersion(application) {
  try {
    return application.getCapturePolicyVersion() ?? null;
  } catch {
    return null;
  }
}
