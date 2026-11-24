import { InvalidInputError } from '../app/application-error.js';
import { GLOBAL_WRITE_KINDS } from '../graphiti/global-writes-port.js';
import { mapHttpError } from '../http/error-mapping.js';
import { requiredString } from '../validation/values.js';

// A follower's writes to `global`, which this computer owns, applied here
// (docs/runner-roles-design.md §12): one outbox entry carries one checkpoint's
// ops, or one recruitment of a project the follower owns. Only the kinds below
// are applied, each through the method this computer's own clients use, one
// after another; each gets its own outcome, and one refused never stops the
// others. A refusal is the method's own code. A failure the entry can outlive
// (this computer's Provider away or failing) fails the whole entry, so the
// follower delivers it again; every kind is safe to apply again (idempotency
// keys, a hire that answers the FLA it made). The caller applies an entry id
// once and runs it as the runner's call (host-routes.js).
const MAX_OPS = 32;
const KIND_LABEL = /^[a-z][a-z0-9_]{0,63}$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]{1,79}$/;

const APPLY = Object.freeze({
  [GLOBAL_WRITE_KINDS.capture]: async (app, input) => {
    if (input.personalProjectId) throw new InvalidInputError('A capture for global names no project');
    const result = await app.captureSessionKnowledge({ ...input, spaceId: app.config.personal.spaceId,
      personalProjectId: null });
    return result?.route === 'disabled' ? 'capture_disabled' : null;
  },
  [GLOBAL_WRITE_KINDS.agentMemory]: async (app, input) => {
    const result = await app.checkpointProjectAgentMemory({ personalSpaceId: app.config.personal.spaceId,
      personalProjectId: null, agentId: requiredString(input.agentId, 'agentId'),
      expectedRevision: input.expectedRevision, idempotencyKey: requiredString(input.idempotencyKey, 'idempotencyKey'),
      memory: input.memory, sourceApplication: input.sourceApplication, sourceSessionId: input.sourceSessionId ?? null });
    return result?.status === 'capture_disabled' ? 'capture_disabled' : null;
  },
  [GLOBAL_WRITE_KINDS.knowledgeUsage]: async (app, input) => {
    if (!Array.isArray(input.items)) throw new InvalidInputError('items must be an array');
    await app.recordKnowledgeUsage({ personalSpaceId: app.config.personal.spaceId,
      taskId: requiredString(input.taskId, 'taskId'), sessionId: input.sessionId ?? null,
      toolName: 'checkpoint_task_knowledge', items: input.items });
    return null;
  },
  // No notice of its own here: the FLA's record says which computer and project hired it.
  [GLOBAL_WRITE_KINDS.recruit]: async (app, input, { computer }) => {
    try {
      await app.personal.hireForFollowerRecruitment({ personalSpaceId: app.config.personal.spaceId,
        recruitmentId: requiredString(input.recruitmentId, 'recruitmentId'),
        agentId: requiredString(input.proposedAgentId, 'proposedAgentId'),
        profile: input.profile, occupation: input.occupation, reason: input.reason ?? null,
        origin: { computer, project: input.projectName ?? null } });
    } catch (error) {
      // A Provider older than the hire answers the path itself as not found, with no code of its own.
      if (error?.status === 404 && error.code === 'provider_error') return 'host_too_old';
      throw error;
    }
    return null;
  }
});

// input: { ops: [{ kind, v: 1, input }] } (graphiti/global-writes-port.js).
// computer: the paired runner's name, which a hired FLA's origin records.
// Answers { ops: [{ kind, outcome: 'applied' | 'refused', code }] } in the order sent.
export async function applyGlobalWrites(app, input, { computer }) {
  if (!Array.isArray(input?.ops) || !input.ops.length || input.ops.length > MAX_OPS) {
    throw new InvalidInputError(`ops must be an array of 1 to ${MAX_OPS} writes`);
  }
  const ops = [];
  for (const op of input.ops) ops.push(await applyOne(app, op, { computer }));
  return { ops };
}

async function applyOne(app, op, origin) {
  const kind = typeof op?.kind === 'string' && KIND_LABEL.test(op.kind) ? op.kind : 'unknown';
  const apply = op?.v === 1 && Object.hasOwn(APPLY, kind) ? APPLY[kind] : null;
  if (!apply) return refused(kind, 'op_unknown');
  if (!op.input || typeof op.input !== 'object' || Array.isArray(op.input)) return refused(kind, 'invalid_input');
  try {
    const refusal = await apply(app, op.input, origin);
    return refusal ? refused(kind, refusal) : { kind, outcome: 'applied', code: null };
  } catch (error) {
    if (mapHttpError(error).status >= 500) throw error;
    return refused(kind, typeof error?.code === 'string' && REFUSAL_CODE.test(error.code) ? error.code : 'host_refused');
  }
}

function refused(kind, code) {
  return { kind, outcome: 'refused', code };
}
