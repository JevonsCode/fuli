import { captureDecision, taskCaptureScope } from './capture-decision.js';

// The capture decision one task checkpoint is made under. With capture off the
// task still closes for its Stop hook, but the stored checkpoint keeps no words
// from the session (its work log is later delivered to the Agent as working
// context). The stored form names the decision, so a retry keeps the decision
// its first attempt made: turning capture back on never records what the off
// period did not, and a retry resends exactly the claim already stored.
const UNCAPTURED = /^Capture was off for this task \((\w+): (\w+)\); FULI kept no summary\.$/;

export function checkpointCaptureDecision(application, task) {
  const stored = UNCAPTURED.exec(task.checkpoint?.reason ?? '');
  return stored ? { allowed: false, reason: stored[2], layer: stored[1] }
    : captureDecision(application, taskCaptureScope(task));
}

// What the checkpoint stores: the first attempt's record when one exists,
// otherwise the record the decision allows.
export function storedCheckpoint(task, recorded, decision) {
  if (task.checkpoint ? !UNCAPTURED.test(task.checkpoint.reason ?? '') : decision.allowed) return recorded;
  const summary = `Capture was off for this task (${decision.layer}: ${decision.reason}); FULI kept no summary.`;
  // Knowledge usage feeds preference promotion, so it stops too (rec#11 D-01).
  const { knowledgeUsage: _notRecorded, ...kept } = recorded;
  return { ...kept, reason: summary, captureStatus: 'capture_disabled',
    ...(recorded.workLog ? { workLog: { status: recorded.workLog.status, summary } } : {}) };
}
