import { createHash } from 'node:crypto';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';

// Reusable experience from a finished task (borrowed from Hy-Memory's working
// memory: one fact per task is the workLog; experiences are the 0-N approaches
// worth reusing). The finishing host writes them; FULI never calls a model.
// They become one pending current-project capture with searchKeys as terms.
const MAX_EXPERIENCES = 3;
const MAX_KEYS = 8;

export function experienceCapture(task, experiences, { sourceApplication = 'other', now = new Date() } = {}) {
  if (!Array.isArray(experiences) || !experiences.length || experiences.length > MAX_EXPERIENCES) {
    throw invalid(`experiences takes 1 to ${MAX_EXPERIENCES} items`);
  }
  const seen = new Set();
  const entities = experiences.map(experience => {
    const title = text(experience?.task, 240, 'experiences[].task');
    const solution = text(experience?.solution, 2000, 'experiences[].solution');
    const boundary = experience?.boundary == null ? null : text(experience.boundary, 600, 'experiences[].boundary');
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
      attributes: { searchTerms: keys, solution, ...(boundary ? { boundary } : {}) },
      originQuadrant: 'known_known', epistemicStatus: 'observed', confirmationStatus: 'pending',
      confirmationBasis: { existenceReason: 'The task owner reported this approach after completing the task.',
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

function text(value, limit, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be non-empty text`);
  return value.trim().slice(0, limit);
}

function invalid(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
