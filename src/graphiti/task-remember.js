import { createHash } from 'node:crypto';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { experienceCapture } from './task-experiences.js';

// Compact memory routing at checkpoint (F-P0-08): the finishing host lists what
// to remember as plain items and FULI builds the routed capture. The chat tool
// list stays small and models do not have to guess the full graph shape.
// Preferences go to the personal profile unless limited to this project; the
// user's own words are the evidence global scope requires. Project facts stay
// in the current project. Everything is pending until a person confirms it.
const MAX_ITEMS = 8;
const ASPECTS = new Set(['taste', 'personality', 'judgment_preference']);

export function rememberCapture(task, remember, { sourceApplication = 'other', now = new Date() } = {}) {
  if (!Array.isArray(remember) || !remember.length || remember.length > MAX_ITEMS) {
    throw invalid(`remember takes 1 to ${MAX_ITEMS} items`);
  }
  const quotes = [];
  const items = remember.map((item, index) => {
    const statement = text(item?.text, 2000, 'remember[].text');
    const key = `remember-${index + 1}`;
    if (item?.kind === 'project_fact') {
      return { scope: 'current_project', entity: entity(task, key, statement, 'ProjectFact', null,
        'The user stated this project fact during the task.') };
    }
    if (item?.kind !== 'preference') throw invalid('remember[].kind must be preference or project_fact');
    const aspect = item.aspect ?? 'judgment_preference';
    if (!ASPECTS.has(aspect)) throw invalid('remember[].aspect must be taste, personality or judgment_preference');
    const scope = item.scope ?? 'global';
    if (scope !== 'global' && scope !== 'project') throw invalid('remember[].scope must be global or project');
    if (scope === 'global') quotes.push(text(item.quote, 600, 'remember[].quote (the user\'s own words, required for a global preference)'));
    return { scope: scope === 'global' ? 'personal_global' : 'current_project',
      entity: entity(task, key, statement, 'PersonalPreference', aspect, 'The user stated this preference during the task.') };
  });
  const entities = items.map(item => item.entity);
  const digest = createHash('sha256').update(JSON.stringify(remember)).digest('hex').slice(0, 16);
  const captureRouting = ['personal_global', 'current_project']
    .map(scope => ({ scope, entityKeys: items.filter(item => item.scope === scope).map(item => item.entity.key),
      relationshipKeys: [], ...(scope === 'personal_global' ? { sourceExcerpt: quotes.join(' / ').slice(0, 2000) } : {}) }))
    .filter(batch => batch.entityKeys.length);
  return {
    capture: { idempotencyKey: `${task.token}:remember:${digest}`, name: 'Remembered at checkpoint',
      sourceKind: 'task_remember', sourceDescription: 'Items the task owner was asked to remember',
      sourceApplication, referenceTime: now.toISOString(), entities, relationships: [] },
    captureRouting
  };
}

// experiences and remember share one capture so a checkpoint stays one write.
export function compactTaskCapture(task, { experiences = null, remember = null }, options = {}) {
  const parts = [experiences && experienceCapture(task, experiences, options),
    remember && rememberCapture(task, remember, options)].filter(Boolean);
  if (parts.length === 1) return parts[0];
  const [first, second] = parts;
  const routing = new Map();
  for (const batch of [...first.captureRouting, ...second.captureRouting]) {
    const merged = routing.get(batch.scope);
    routing.set(batch.scope, merged ? { ...merged, entityKeys: [...merged.entityKeys, ...batch.entityKeys] } : batch);
  }
  return {
    capture: { ...second.capture, idempotencyKey: `${first.capture.idempotencyKey}+${second.capture.idempotencyKey.split(':').pop()}`,
      entities: [...first.capture.entities, ...second.capture.entities] },
    captureRouting: [...routing.values()]
  };
}

function entity(task, key, statement, type, profileAspect, existenceReason) {
  return {
    key, name: statement.slice(0, 120), type, summary: statement,
    ...(profileAspect ? { profileAspect } : {}),
    originQuadrant: 'known_known', epistemicStatus: 'observed', confirmationStatus: 'pending',
    confirmationBasis: { existenceReason,
      quadrantReason: 'Stated directly; it stays pending until a person confirms it.',
      proposedBy: { kind: 'agent', label: task.projectAgentId ?? null } }
  };
}

function text(value, limit, field) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} must be non-empty text`);
  return value.trim().slice(0, limit);
}

function invalid(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
