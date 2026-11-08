import { createHash } from 'node:crypto';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { ONLY_MARKUP, withoutFuliMarkup } from './fuli-markup.js';
import { experienceCapture } from './task-experiences.js';
import { PREFERENCE_CONSTRAINTS, TASTE_DOMAINS, WORK_KINDS, taskWorkKind } from './task-scene.js';

// Compact memory routing at checkpoint (F-P0-08): the finishing host lists what
// to remember as plain items and FULI builds the routed capture. The chat tool
// list stays small and models do not have to guess the full graph shape.
// Preferences go to the personal profile unless limited to this project; the
// user's own words are the evidence global scope requires. Project facts stay
// in the current project. Everything is pending until a person confirms it.
// A preference whose scope the user left open (scope unsure) waits in the
// session's temporary project, scope undecided (rec#20), never guessed global.
const MAX_ITEMS = 8;
// Hosts such as Claude Code keep their own memory files; a request to keep
// something must still reach FULI. Detected only on the prompt, so ordinary
// tasks carry no extra entry text.
// rec#63: "make sure this decision is remembered" and "keep this for later
// sessions" were missed, and the model wrote only a repository file.
const REMEMBER_REQUEST = new RegExp('(?:记住|记一下|记下来|记好|别忘|以后要用|今后|往后|以后(?:都|也|就)?(?:要|按|用|这样)|下次(?:也|还)?(?:要|按|用)'
  + '|\\bremember(?:ed|s|ing)?\\b|keep in mind|don\'?t forget|from now on|going forward'
  + '|\\b(?:keep|save|note) (?:this|it|that)(?: \\w+){0,2} for (?:later|next time|future)'
  + '|\\bfor (?:later|future) (?:sessions?|work|tasks?|reference)|\\bfuture (?:sessions?|work)\\b)', 'iu');
export const REMEMBER_GUIDANCE = 'The user asked to keep something: record it with checkpoint_task_knowledge remember (preference or project_fact) before finishing; a repository file or the host memory files are not FULI memory.';

export function rememberRequested(taskPrompt) {
  return typeof taskPrompt === 'string' && REMEMBER_REQUEST.test(taskPrompt);
}
const ASPECTS = new Set(['taste', 'personality', 'judgment_preference']);

export function rememberCapture(task, remember, { sourceApplication = 'other', now = new Date() } = {}) {
  if (!Array.isArray(remember) || !remember.length || remember.length > MAX_ITEMS) {
    throw invalid(`remember takes 1 to ${MAX_ITEMS} items`);
  }
  const quotes = [];
  const seen = new Set();
  const items = remember.map(item => {
    const statement = text(item?.text, 2000, 'remember[].text');
    // The key identifies the remembered content, not its position: a stable key
    // per position made every later task's first item collide with an earlier
    // one in the same scope, and the new knowledge was silently dropped.
    const key = `remember-${createHash('sha256').update(JSON.stringify([item?.kind, statement])).digest('hex').slice(0, 24)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (item?.kind === 'project_fact') {
      return { scope: 'current_project', entity: entity(task, key, statement, 'ProjectFact', null,
        'The user stated this project fact during the task.') };
    }
    if (item?.kind !== 'preference') throw invalid('remember[].kind must be preference or project_fact');
    const aspect = item.aspect ?? 'judgment_preference';
    if (!ASPECTS.has(aspect)) throw invalid('remember[].aspect must be taste, personality or judgment_preference');
    const scope = item.scope ?? 'global';
    if (!['global', 'project', 'unsure'].includes(scope)) throw invalid('remember[].scope must be global, project or unsure');
    if (scope === 'global') quotes.push(text(item.quote, 600, 'remember[].quote (the user\'s own words, required for a global preference)'));
    return { scope: { global: 'personal_global', project: 'current_project', unsure: 'session_temporary' }[scope],
      entity: { ...entity(task, key, statement, 'PersonalPreference', aspect, 'The user stated this preference during the task.'),
        ...sceneAttributes(item) } };
  }).filter(Boolean);
  const entities = items.map(item => item.entity);
  const digest = createHash('sha256').update(JSON.stringify(remember)).digest('hex').slice(0, 16);
  const captureRouting = ['personal_global', 'current_project', 'session_temporary']
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
    // The user asked to keep it in their own words; still pending until confirmed.
    contentSource: 'user_explicit',
    confirmationBasis: { existenceReason,
      quadrantReason: 'Stated directly; it stays pending until a person confirms it.',
      proposedBy: { kind: 'agent', label: task.projectAgentId ?? null } }
  };
}

// The scene qualifiers a user stated (task-scene.js); never inferred from the text. constraint
// is listed as an enum and checked. workKind and tasteDomain stay plain strings in the chat
// listing to save tokens on every request (rec#95), so an unlisted value never rejects the
// item: a work kind is read with the same hints as a task prompt ("front-end styling" →
// frontend), and anything still unknown is left off; the preference itself is kept.
function sceneAttributes(item) {
  const attributes = {};
  if (item.constraint !== undefined) {
    if (!PREFERENCE_CONSTRAINTS.includes(item.constraint)) throw invalid(`remember[].constraint must be one of ${PREFERENCE_CONSTRAINTS.join(', ')}`);
    attributes.constraint = item.constraint;
  }
  const workKind = listedOrHinted(item.workKind, WORK_KINDS, value => taskWorkKind(value.replace(/_+/gu, ' ')));
  if (workKind) attributes.workKind = workKind;
  const tasteDomain = listedOrHinted(item.tasteDomain, TASTE_DOMAINS, () => null);
  if (tasteDomain) attributes.tasteDomain = tasteDomain;
  return Object.keys(attributes).length ? { attributes } : {};
}

function listedOrHinted(value, allowed, hint) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const plain = value.trim().toLowerCase();
  return allowed.includes(plain) ? plain : hint(plain);
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
