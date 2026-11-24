// Why this entry asks for a checkpoint, or why it does not (rec#137).
// `checkpoint_required` flipped between neighbouring turns of one session with
// nothing in the entry to say what changed, so an Agent could neither predict
// it nor explain it to the person. The reason is a short sentence in plain
// words rather than a code: it costs about forty bytes a turn and needs no
// rules section to be understood.
//
// Everything here is read from what the entry already holds. FULI never
// guesses: a requirement it cannot place says so.

// The first of these that holds, in the order a reader would ask.
const REQUIRED = [
  [({ remembering }) => remembering, 'this turn asks FULI to keep something'],
  [({ updating }) => updating, 'this turn says something FULI keeps may have changed'],
  [({ task }) => (task.coordinationTaskIds ?? []).length > 0 || task.coordinationTaskId,
    'this task coordinates other Agents'],
  [({ task }) => task.activityOrigin, 'this task runs for another activity'],
  [({ task }) => task.agentMemoryScope === 'task_only', 'this task keeps memory for itself only'],
  [({ task }) => task.workLogRequired, 'this Agent keeps a working memory, so its work log is required'],
  [({ entryVia }) => entryVia !== 'hook', 'no Stop hook closes a task entered through a tool'],
  [() => true, 'FULI cannot close this task by itself']
];

// Why no checkpoint is required.
const NOT_REQUIRED = [
  [({ task }) => task.checkpoint?.phase === 'complete', 'this task is already checkpointed'],
  [({ entryVia, task }) => entryVia === 'hook' && task.entryVia === 'hook', 'the Stop hook closes this task'],
  [() => true, 'a routine fallback closes this task at the next entry of this session']
];

function checkpointReason(facts, required) {
  return (required ? REQUIRED : NOT_REQUIRED).find(([holds]) => holds(facts))[1];
}

// Whether a task needs the model's checkpoint, and why. The entry that opens
// the task decides it; a later read of the same task replays the same rule
// from what the task keeps (taskCheckpointReplay), so the two never disagree.
// A request to keep or change something is never a routine auto-closed task.
export function taskCheckpoint({ remembering, updating, task, entryVia }) {
  const autoClosed = !remembering && !updating
    && ((entryVia === 'hook' && task.entryVia === 'hook') || task.routineAutoCloseEligible === true);
  const required = !autoClosed && task.checkpoint?.phase !== 'complete';
  return { autoClosed, required, reason: checkpointReason({ remembering, updating, task, entryVia }, required) };
}

// What the person asked of the task at its entry, kept with it
// (checkpoint_request): 'remember', 'update' or null.
export function checkpointRequest({ remembering, updating }) {
  return remembering ? 'remember' : updating ? 'update' : null;
}

// The entry's decision for an open task, replayed by a later read
// (read_task_preferences, design T2): the same rule over what the task keeps,
// through the entry it was opened by. A task kept before its request was
// (checkpointRequest undefined) needs the checkpoint, as before. A routine
// fallback's eligibility is decided at entry only, so such a task read later
// needs one too: the conservative side.
export function taskCheckpointReplay(task) {
  if (task.checkpointRequest === undefined) return null;
  return taskCheckpoint({ remembering: task.checkpointRequest === 'remember', updating: task.checkpointRequest === 'update',
    task, entryVia: task.entryVia });
}
