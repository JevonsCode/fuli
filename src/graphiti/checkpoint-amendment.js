import { validationError } from '../app/application-error.js';
import { storedCaptureOff, storedCheckpoint } from './checkpoint-capture.js';

// rec#85: a checkpoint is immutable, so a retry with other input is refused and
// never overwrites it. A checkpoint sent too early is corrected by an explicit
// amendment instead: a new reason and work log appended under the completed
// original, which stays as history. Capture, memory, usage and team decisions
// already applied are not part of an amendment.
const AMEND_ONLY = ['capture', 'captureRouting', 'agentMemory', 'knowledgeUsage', 'triage', 'experiences', 'remember'];

export function checkpointConflictMessage(checkpoint) {
  return checkpoint?.phase === 'complete'
    ? 'Task checkpoint already has different input. A retry resends the exact first arguments; to correct a checkpoint sent too early, call again with amend: true and only the corrected reason and workLog (the first record stays)'
    : 'Task checkpoint already has different input; resend the exact arguments of the first checkpoint call to finish it, then amend it with amend: true, or begin a new task context';
}

export function assertAmendmentInput(task, input) {
  const extra = AMEND_ONLY.filter(key => input[key] != null);
  if (extra.length || input.collaborators?.length) {
    throw validationError(`An amendment carries only reason and workLog; decisions already applied stay (remove ${[...extra, ...(input.collaborators?.length ? ['collaborators'] : [])].join(', ')})`);
  }
  if (task.checkpoint?.phase !== 'complete') {
    throw validationError('Nothing to amend yet: finish this task with checkpoint_task_knowledge first (without amend)');
  }
  if (input.disposition !== task.checkpoint.disposition) {
    throw validationError(`An amendment keeps the checkpoint disposition ${task.checkpoint.disposition}`);
  }
}

// Appends the amendment, or replays one already kept. With capture off the
// amendment keeps no words, as the checkpoint it corrects. What follows (the
// conversation event, the receipt) is built from the entry the Provider kept,
// with its own sequence and capture decision: a retry after capture came back
// on never records the off-period words it resent, and a retry of an older
// amendment never takes a newer one's event.
export async function amendCheckpoint(application, task, { disposition, reason, workLog, fingerprint }, captureCheck) {
  const recorded = storedCheckpoint({ checkpoint: null }, { disposition, reason, fingerprint,
    ...(task.projectAgentId ? { workLog: workLog ?? { status: 'reported', summary: reason } } : {}) }, captureCheck);
  const { task: amended, amendment } = await application.taskContextRegistry.amend(task.token,
    { disposition, reason: recorded.reason, fingerprint, workLog: recorded.workLog ?? null }, task.sourceApplication);
  return { task: amended, sequence: amendment.sequence, replayed: amendment.replayed,
    log: amendment.work_log ?? { status: 'reported', summary: amendment.reason },
    decision: storedCaptureOff(amendment.reason) ?? captureCheck };
}

// The outcome a checkpoint stands for now: its latest amendment, else itself.
// Takes the Provider's record (snake_case).
export function currentCheckpointWorkLog(checkpoint) {
  return (checkpoint.amendments?.at(-1) ?? checkpoint).work_log;
}
