import { SOURCE_APPLICATIONS } from '../agents/source-applications.js';
import { InvalidInputError } from '../app/application-error.js';
import { captureDecision } from '../graphiti/capture-decision.js';
import { GLOBAL_WRITE_KINDS } from '../graphiti/global-writes-port.js';
import { mapHttpError } from '../http/error-mapping.js';
import { withoutControls } from '../text/control-characters.js';
import { requiredString } from '../validation/values.js';

// A follower's writes to `global`, which this computer owns, applied here
// (docs/runner-roles-design.md §12): one outbox entry carries one checkpoint's
// ops, or one recruitment of a project the follower owns. Only the kinds below
// are applied, each through the method this computer's own clients use, one
// after another; each gets its own outcome, and one refused never stops the
// others. A refusal is the method's own code. The caller applies an entry id
// once and runs it as the paired runner's call (host-routes.js).
//
// Delivered again: this computer's Provider away or failing (a 5xx, a timeout)
// fails the whole entry, and the host keeps nothing of it, so the follower's
// outbox delivers it again and every op runs again, those that had already
// been applied included. Each is safe to run twice: a capture and an FLA's
// memory carry the checkpoint's idempotency keys, a use is recorded once per
// task, item and kind of use, and a hire answers the FLA it already made.
//
// Size: the replay route reads as much as one MCP request may carry (1 MiB,
// host-routes.js), so the capture a checkpoint could send online also arrives
// through the outbox. A checkpoint sends at most three ops (its global capture,
// its FLA's global memory, its uses); a larger entry is refused (413) for good.
const MAX_OPS = 32;
// Tool-schema bounds (agent-tools/project-agent-definitions.js) and the Provider's usage batch.
const MAX_ID = 256;
const MAX_USES = 200;
const MAX_PROFILE_BYTES = 16 * 1024;
const MAX_OCCUPATION_BYTES = 4 * 1024;
const MAX_REASON = 2000;
const MAX_PROJECT_NAME = 200;
// The Provider's owner-hire request (graph-provider/fuli_graph/owner_hire.py OwnerHireRequest):
// recruitment_id and agent_id at most 128, origin_computer at most 128, the fingerprint whole.
const MAX_HIRE_ID = 128;
const MAX_ORIGIN_COMPUTER = 128;
const FINGERPRINT = /^[0-9a-f]{64}$/;
// What names a computer whose pairing record has no name, as a task issuer does (task-issuer.js).
const FINGERPRINT_PREFIX = 16;
const KIND_LABEL = /^[a-z][a-z0-9_]{0,63}$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]{1,79}$/;

const APPLY = Object.freeze({
  [GLOBAL_WRITE_KINDS.capture]: async (app, input) => {
    if (input.personalProjectId) throw new InvalidInputError('A capture for global names no project');
    const result = await app.captureSessionKnowledge({ ...input, spaceId: app.config.personal.spaceId,
      personalProjectId: null });
    return result?.route === 'disabled' ? { refused: 'capture_disabled' } : {};
  },
  [GLOBAL_WRITE_KINDS.agentMemory]: async (app, input) => {
    const result = await app.checkpointProjectAgentMemory({ personalSpaceId: app.config.personal.spaceId,
      personalProjectId: null, agentId: requiredString(input.agentId, 'agentId', MAX_ID),
      expectedRevision: input.expectedRevision, idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
      memory: input.memory, sourceApplication: input.sourceApplication, sourceSessionId: input.sourceSessionId ?? null });
    return result?.status === 'capture_disabled' ? { refused: 'capture_disabled' } : {};
  },
  [GLOBAL_WRITE_KINDS.knowledgeUsage]: recordGlobalUses,
  // No notice of its own here: the FLA's record says which computer and project hired it.
  [GLOBAL_WRITE_KINDS.recruit]: async (app, input, runner) => {
    const hire = { personalSpaceId: app.config.personal.spaceId,
      recruitmentId: requiredString(input.recruitmentId, 'recruitmentId', MAX_HIRE_ID),
      agentId: requiredString(input.proposedAgentId, 'proposedAgentId', MAX_HIRE_ID),
      profile: boundedObject(input.profile, 'profile', MAX_PROFILE_BYTES),
      occupation: boundedObject(input.occupation, 'occupation', MAX_OCCUPATION_BYTES),
      reason: requiredLine(input.reason, 'reason', MAX_REASON),
      origin: { computer: originComputer(runner),
        fingerprint: FINGERPRINT.test(runner.fingerprint) ? runner.fingerprint : null,
        project: requiredLine(input.projectName, 'projectName', MAX_PROJECT_NAME) } };
    if (hire.profile.agent_type === 'temporary' || input.taskId != null) {
      requiredString(input.taskId, 'taskId');
      // The Provider binds the exact stored ID and counts Unicode characters.
      if ([...input.taskId].length > MAX_HIRE_ID) throw new InvalidInputError('taskId is too long');
      hire.taskId = input.taskId;
    }
    if (SOURCE_APPLICATIONS.includes(input.recruitmentSourceApplication)) {
      hire.recruitmentSourceApplication = input.recruitmentSourceApplication;
    }
    try {
      await app.personal.hireForFollowerRecruitment(hire);
    } catch (error) {
      // Only a Provider without the route says it so: the framework's own Not Found, with no code.
      // A 404 the hire itself answers (its space gone) keeps its code.
      if (error?.status === 404 && error.code === 'provider_error') return { refused: 'host_too_old' };
      throw error;
    }
    return {};
  }
});

// input: { ops: [{ kind, v: 1, input }] } (graphiti/global-writes-port.js).
// runner: { fingerprint, name } of the paired runner, which a hired FLA's origin records.
// Answers { ops: [{ kind, outcome: 'applied' | 'refused', code, skipped? }] } in the order sent.
export async function applyGlobalWrites(app, input, runner) {
  if (!Array.isArray(input?.ops) || !input.ops.length || input.ops.length > MAX_OPS) {
    throw new InvalidInputError(`ops must be an array of 1 to ${MAX_OPS} writes`);
  }
  const ops = [];
  for (const op of input.ops) ops.push(await applyOne(app, op, runner));
  return { ops };
}

async function applyOne(app, op, runner) {
  const kind = typeof op?.kind === 'string' && KIND_LABEL.test(op.kind) ? op.kind : 'unknown';
  const apply = op?.v === 1 && Object.hasOwn(APPLY, kind) ? APPLY[kind] : null;
  if (!apply) return refused(kind, 'op_unknown');
  if (!op.input || typeof op.input !== 'object' || Array.isArray(op.input)) return refused(kind, 'invalid_input');
  let outcome;
  try {
    outcome = await apply(app, op.input, runner);
  } catch (error) {
    if (mapHttpError(error).status >= 500) throw error;
    return refused(kind, typeof error?.code === 'string' && REFUSAL_CODE.test(error.code) ? error.code : 'host_refused');
  }
  const skipped = outcome.skipped?.length ? { skipped: outcome.skipped } : {};
  return outcome.refused ? { ...refused(kind, outcome.refused), ...skipped }
    : { kind, outcome: 'applied', code: null, ...skipped };
}

// The use of items of global this computer owns, under its own capture
// decision for that client and session, as its own record_knowledge_usage is.
// Only items whose scope is global here count: the Provider records a batch
// in one transaction and refuses the whole of it for one item it no longer has
// (404, or 410 once deleted for good), so each item is looked at first, and one gone or not of global is
// left out and named (skipped) instead of failing or counting.
async function recordGlobalUses(app, input) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_USES) {
    throw new InvalidInputError(`items must be an array of 1 to ${MAX_USES} uses`);
  }
  const taskId = requiredString(input.taskId, 'taskId', MAX_ID);
  const capture = await captureDecision(app, { sourceApplication: requiredString(input.sourceApplication, 'sourceApplication'),
    personalProjectId: null, sessionId: input.sessionId ?? null });
  if (!capture.allowed) return { refused: 'capture_disabled' };
  const scopes = new Map();
  for (const item of input.items) {
    const key = `${item?.itemKind}:${item?.itemId}`;
    if (!scopes.has(key)) scopes.set(key, await itemScope(app, item));
  }
  const skipped = [...scopes].filter(([, scope]) => scope !== 'global').map(([key, scope]) => {
    const [itemKind, ...id] = key.split(':');
    return { itemKind, itemId: id.join(':'), reason: scope === null ? 'not_found' : 'not_global' };
  });
  const uses = input.items.filter(item => scopes.get(`${item.itemKind}:${item.itemId}`) === 'global');
  if (!uses.length) return { refused: 'no_global_items', skipped };
  await app.recordKnowledgeUsage({ personalSpaceId: app.config.personal.spaceId, taskId,
    sessionId: input.sessionId ?? null, toolName: 'checkpoint_task_knowledge', items: uses });
  return { skipped };
}

// The item's scope kind here, or null when this computer has no item a plain
// session may see by that key: not found (404), or deleted for good (410).
async function itemScope(app, item) {
  if (!['entity', 'relationship'].includes(item?.itemKind)) throw new InvalidInputError('itemKind must be entity or relationship');
  try {
    const view = await app.personal.readKnowledgeItemView({ personalSpaceId: app.config.personal.spaceId,
      itemKind: item.itemKind, itemId: requiredString(item.itemId, 'itemId', MAX_ID) });
    return typeof view?.scope?.kind === 'string' ? view.scope.kind : 'unknown';
  } catch (error) {
    if (error?.status === 404 || error?.status === 410) return null;
    throw error;
  }
}

function boundedObject(value, label, maxBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError(`${label} must be a JSON object`);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new InvalidInputError(`${label} is too large`);
  return value;
}

// One line people read, never empty: the Provider requires it.
function requiredLine(value, label, maximum) {
  if (typeof value !== 'string') throw new InvalidInputError(`${label} must be text`);
  const line = withoutControls(value);
  if (!line) throw new InvalidInputError(`${label} must not be empty`);
  if (line.length > maximum) throw new InvalidInputError(`${label} is too long`);
  return line;
}

// The paired computer as the roster shows it; one paired without a name is
// named by its fingerprint, since the Provider requires a name.
function originComputer(runner) {
  const name = typeof runner.name === 'string' ? [...withoutControls(runner.name)].slice(0, MAX_ORIGIN_COMPUTER).join('') : '';
  return name || String(runner.fingerprint ?? '').slice(0, FINGERPRINT_PREFIX);
}

function refused(kind, code) {
  return { kind, outcome: 'refused', code };
}
