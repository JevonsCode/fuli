import { createHash } from 'node:crypto';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { ONLY_MARKUP, withoutFuliMarkup } from './fuli-markup.js';

// Reusable experience from a finished task (borrowed from Hy-Memory's working
// memory: one fact per task is the workLog; experiences are the 0-N approaches
// worth reusing). The finishing host writes them; FULI never calls a model.
// They become one pending current-project capture with searchKeys as terms.
const MAX_EXPERIENCES = 3;
const MAX_KEYS = 8;
// What a lesson can become besides text (rec#78, 11-06 addition 2): an item
// its project's acceptance list holds once the person keeps it.
export const CHECK_KINDS = Object.freeze(['acceptance_item', 'regression_example']);
const CHECK_CHARS = 300;

export function experienceCapture(task, experiences, { sourceApplication = 'other', now = new Date() } = {}) {
  if (!Array.isArray(experiences) || !experiences.length || experiences.length > MAX_EXPERIENCES) {
    throw invalid(`experiences takes 1 to ${MAX_EXPERIENCES} items`);
  }
  const seen = new Set();
  const entities = experiences.map(experience => {
    const title = text(experience?.task, 240, 'experiences[].task');
    const solution = text(experience?.solution, 2000, 'experiences[].solution');
    const boundary = experience?.boundary == null ? null : text(experience.boundary, 600, 'experiences[].boundary');
    const check = experience?.check == null ? null : lessonCheck(experience.check);
    // A person's lasting correction (rec#78 step 3): the strongest signal, with its boundary.
    const corrected = experience?.origin === 'correction';
    if (corrected && !boundary) throw invalid('A lasting correction needs its boundary: where the rule applies');
    const keys = Array.isArray(experience?.searchKeys)
      ? [...new Set(experience.searchKeys.map(key => text(key, 80, 'experiences[].searchKeys')))] : [];
    if (!keys.length || keys.length > MAX_KEYS) throw invalid(`experiences[].searchKeys takes 1 to ${MAX_KEYS} terms`);
    // Keyed by content: a positional key collided with earlier experiences in the project.
    const key = `experience-${createHash('sha256').update(JSON.stringify([title, solution])).digest('hex').slice(0, 24)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      key, name: title, type: 'ReusableExperience',
      summary: boundary ? `${solution}\n适用边界：${boundary}` : solution,
      attributes: { searchTerms: keys, solution, ...(boundary ? { boundary } : {}), ...(check ? { check } : {}),
        ...(corrected ? { origin: 'correction' } : {}) },
      originQuadrant: 'known_known', epistemicStatus: 'observed', confirmationStatus: 'pending',
      contentSource: 'agent_inferred',
      confirmationBasis: { existenceReason: corrected ? 'The person corrected the task owner\'s approach; the owner judged it a lasting rule.'
          : 'The task owner reported this approach after completing the task.',
        quadrantReason: 'Observed in this task; it stays pending until a person confirms it.',
        proposedBy: { kind: 'agent', label: task.projectAgentId ?? null } }
    };
  }).filter(Boolean);
  const digest = createHash('sha256').update(JSON.stringify(entities)).digest('hex').slice(0, 16);
  return {
    capture: { idempotencyKey: `${task.token}:experiences:${digest}`, name: 'Reusable experience',
      sourceKind: 'task_experience', sourceDescription: 'Reusable approaches reported at task checkpoint',
      sourceApplication, referenceTime: now.toISOString(), entities, relationships: [] },
    captureRouting: [{ scope: 'current_project', entityKeys: entities.map(entity => entity.key), relationshipKeys: [] }]
  };
}

function lessonCheck(value) {
  if (!CHECK_KINDS.includes(value?.kind)) throw invalid(`experiences[].check.kind is one of ${CHECK_KINDS.join(', ')}`);
  return { kind: value.kind, text: text(value.text, CHECK_CHARS, 'experiences[].check.text') };
}

function text(value, limit, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be non-empty text`);
  const own = withoutFuliMarkup(value);
  if (!own) throw invalid(ONLY_MARKUP(field));
  return own.slice(0, limit);
}

function invalid(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
