import { ApplicationError } from '../app/application-error.js';
import { callingTask } from '../app/calling-task.js';
import { captureDecision, taskCaptureScope } from '../graphiti/capture-decision.js';
import { experienceCapture } from '../graphiti/task-experiences.js';
import { normalizeTaskCaptures, taskCaptureInput } from '../graphiti/task-knowledge-routing.js';

// record_fla_lesson (rec#78 step 3 and the 11-06 additions 2 and 4): the FLA a
// task is bound to records one lesson as it happens, instead of at checkpoint.
// - A person's correction is classified by the FLA: a one-off requirement of
//   this task is applied and not kept; a lasting rule becomes a pending
//   experience with the boundary it applies within.
// - A lesson that can be checked carries its check (an acceptance item or a
//   regression example); once the person keeps it, the project's acceptance
//   list (src/acceptance-checks/) holds it for Tonborg and Jefa.
// Nothing is confirmed here: the person keeps or drops it on the FLA page.
export async function recordFlaLesson(app, input) {
  const task = await callingTask(app, input);
  const corrected = input.origin === 'correction';
  if (corrected && input.correctionScope !== 'lasting') {
    return { status: 'one_off', kept: false,
      guidance: 'A requirement of this task only: apply it here; it is not kept as an experience.' };
  }
  // Only what is kept needs an FLA and a project to belong to.
  if (!task.projectAgentId || !task.personalProjectId) {
    throw new ApplicationError('agent_not_bound', 'Lessons belong to an FLA in a project; this task is not bound to one', { status: 409 });
  }
  const { capture, captureRouting } = experienceCapture(task, [{ task: input.title, solution: input.solution,
    boundary: input.boundary, searchKeys: input.searchKeys, check: input.check, ...(corrected ? { origin: 'correction' } : {}) }],
  { sourceApplication: task.sourceApplication });
  const captureScope = taskCaptureScope(task);
  const decision = await captureDecision(app, captureScope);
  if (!decision.allowed) return { status: 'capture_disabled', kept: false, reason: decision.reason };
  const [batch] = normalizeTaskCaptures(task, capture, captureRouting);
  // Its own key: the checkpoint's capture of this task keys on the task and scope alone.
  const result = await app.captureSessionKnowledge({ ...taskCaptureInput(app.config.personal.spaceId, task, batch),
    idempotencyKey: `${capture.idempotencyKey}:lesson` }, { captureScope });
  return { status: result?.route === 'disabled' ? 'capture_disabled' : 'pending', kept: false,
    ...(input.check ? { check: 'joins the acceptance list once the person keeps it' } : {}),
    guidance: 'Pending on your FLA page (学会了); the person keeps or drops it. Do not repeat it at checkpoint.' };
}
