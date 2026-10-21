import { ApplicationError } from '../app/application-error.js';

const fail = message => { throw new ApplicationError('validation', message); };
const aspects = new Set(['taste', 'personality', 'judgment_preference']);
// session_temporary is FULI's own routing, never a model's: what belongs to no
// chosen scope is kept in the session's temporary project, marked undecided.
const scopes = new Set(['personal_global', 'current_project', 'session_temporary']);
const MAX_ROUTED_SCOPES = 3;

// A task without a registered project has no current project: its project-
// scoped items wait in the session's temporary project, scope undecided
// (rec#20), never guessed global and never shared with other projects or FLAs.
function effectiveScope(task, scope) {
  return scope === 'current_project' && (!task.personalProjectId || task.projectScope?.type === 'temporary')
    ? 'session_temporary' : scope;
}

// Scope is an explicit capture decision, separate from an item's profile aspect.
// This validates the decision; it does not classify text or verify its meaning.
export function normalizeTaskCaptures(task, capture, routing) {
  if (!capture || !Array.isArray(capture.entities) || !capture.entities.length
    || capture.entities.length > 128 || !Array.isArray(capture.relationships) || capture.relationships.length > 256) {
    fail('captureRouting requires one bounded capture episode');
  }
  if (!Array.isArray(routing) || !routing.length || routing.length > MAX_ROUTED_SCOPES) fail('captureRouting requires one or two bounded scope partitions');
  const itemsByKind = [capture.entities, capture.relationships].map(items => {
    const byKey = new Map();
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string' || !item.key.trim()) {
        fail('Capture items require structured objects with non-empty keys');
      }
      if (byKey.has(item.key)) fail('Capture keys must be unique within each item kind');
      byKey.set(item.key, item);
    }
    return byKey;
  });
  const seen = new Set();
  const assigned = [new Set(), new Set()];
  const batches = mergeSameScope(task, routing).map(batch => {
    const { scope, entityKeys, relationshipKeys, sourceExcerpt = capture.sourceExcerpt } = batch;
    if (seen.has(scope)) fail('Each capture scope must be valid and unique');
    seen.add(scope);
    const selections = [entityKeys, relationshipKeys].map((keys, kind) => {
      if (!Array.isArray(keys) || keys.length > (kind ? 256 : 128) || (!kind && !keys.length)) {
        fail('Each scope requires entityKeys and relationshipKeys, with at least one entity');
      }
      for (const key of keys) {
        if (!itemsByKind[kind].has(key) || assigned[kind].has(key)) fail('Routing keys must be known and assigned exactly once per kind');
        assigned[kind].add(key);
      }
      return new Set(keys);
    });
    if (scope === 'personal_global' && (typeof sourceExcerpt !== 'string' || !sourceExcerpt.trim())) {
      fail('personal_global requires sourceExcerpt showing the explicit global scope; ask the user when scope is uncertain');
    }
    const pending = item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('Capture items must be structured objects');
      if (item.profileAspect != null && !aspects.has(item.profileAspect)) fail('Unknown profileAspect');
      if (scope === 'personal_global' && !aspects.has(item.profileAspect)) fail('Global capture accepts only personal preferences');
      const basis = item.confirmationBasis;
      if ((item.confirmationStatus != null && item.confirmationStatus !== 'pending')
        || basis?.confirmedBy != null || basis?.confirmedAt != null || basis?.agentPolicyVersion != null) {
        fail('Scoped AI capture must remain pending until the existing human confirmation flow confirms it');
      }
      // Only FULI's own remember items carry the user's words; a model's graph
      // capture is its inference (rec#20), whatever it is about.
      return { ...item, confirmationStatus: 'pending', contentSource: item.contentSource ?? 'agent_inferred' };
    };
    // Selection order never changes commit identity; preserve the episode's
    // original item order while normalizing scope order below.
    const entities = capture.entities.filter(item => selections[0].has(item.key)).map(pending);
    const relationships = capture.relationships.filter(item => selections[1].has(item.key)).map(pending);
    if (relationships.some(item => !selections[0].has(item.source) || !selections[0].has(item.target))) {
      fail('A capture relationship must reference entities in its own scope batch');
    }
    return { scope, capture: { ...capture, sourceExcerpt, entities, relationships } };
  }).sort((left, right) => left.scope.localeCompare(right.scope));
  if (assigned.some((keys, kind) => keys.size !== itemsByKind[kind].size)) fail('captureRouting must assign every entity and relationship exactly once');
  return batches;
}

// A project-scoped batch without a registered project joins an explicit
// undecided one; anything else keeps its own scope and uniqueness check.
function mergeSameScope(task, routing) {
  const merged = [];
  for (const batch of routing) {
    if (!batch || typeof batch !== 'object' || !scopes.has(batch.scope)) fail('Each capture scope must be valid and unique');
    const scope = effectiveScope(task, batch.scope);
    const same = scope === 'session_temporary' ? merged.find(item => item.scope === scope) : null;
    if (same && Array.isArray(same.entityKeys) && Array.isArray(batch.entityKeys)
      && Array.isArray(same.relationshipKeys) && Array.isArray(batch.relationshipKeys)) {
      same.entityKeys = [...same.entityKeys, ...batch.entityKeys];
      same.relationshipKeys = [...same.relationshipKeys, ...batch.relationshipKeys];
    } else merged.push({ ...batch, scope });
  }
  return merged;
}

export async function preflightTaskCaptures(provider, inputs, prepareCapture) {
  const commits = inputs.map(input => {
    if (input.targetKind !== 'personal') fail('Knowledge commit preflight only accepts personal captures');
    return prepareCapture(input).commit;
  });
  const result = await provider.preflightCommits(commits);
  if (result?.status !== 'validated' || result.count !== commits.length) {
    throw new TypeError('Provider did not confirm every capture preflight');
  }
  return result;
}

// temporaryProjectId: the session's temporary project, for an undecided batch.
export function taskCaptureInput(spaceId, task, { scope, capture }, temporaryProjectId = null) {
  return { ...capture, targetKind: 'personal', spaceId,
    personalProjectId: scope === 'personal_global' ? null
      : scope === 'session_temporary' ? temporaryProjectId : task.personalProjectId,
    ...(scope === 'session_temporary' ? { scopeStatus: 'undetermined' } : {}),
    projectAgentId: null, sessionId: task.sessionId, sourceApplication: task.sourceApplication,
    sourceTurnId: task.turnId ?? capture.sourceTurnId ?? null,
    idempotencyKey: `${task.token}:knowledge:${scope}` };
}

export function taskCaptureReceipt(scope, input, result) {
  const saved = ['committed', 'duplicate'].includes(result?.status);
  if (!saved && result?.status !== 'capture_disabled') throw new TypeError('Provider did not confirm the capture outcome');
  if (saved && (typeof result.episode_id !== 'string' || !result.episode_id
    || !Array.isArray(result.entity_ids) || !result.entity_ids.length || !Array.isArray(result.relationship_ids)
    || [...result.entity_ids, ...result.relationship_ids].some(id => typeof id !== 'string' || !id))) {
    throw new TypeError('Provider did not return its capture receipt');
  }
  return { scope, personal_project_id: input.personalProjectId, status: result.status,
    episode_id: saved ? result.episode_id : null,
    entity_ids: saved ? result.entity_ids : [], relationship_ids: saved ? result.relationship_ids : [] };
}

// A capture sent without routing is saved where its input names: the task's
// project, or no project. Its receipt joins the checkpoint like a routed one.
// That path never required the Provider's IDs, so without them it keeps no
// receipt (nothing could be read back) rather than failing the checkpoint.
export function legacyCaptureReceipts(input, result) {
  if (!input || !['committed', 'duplicate'].includes(result?.status)
    || typeof result.episode_id !== 'string' || !Array.isArray(result.entity_ids) || !result.entity_ids.length) return null;
  return [taskCaptureReceipt(input.personalProjectId ? 'current_project' : 'personal_global', input, result)];
}

// A Provider-admitted sealed worker keeps its checkpoint, work log and memory,
// but its capture payload is never written.
export function internalCaptureSkip(origin) {
  return { route: 'skipped', status: 'internal_activity_skipped', persisted: false,
    reason: 'internal_activity', activity_origin: origin,
    guidance: 'A Provider-admitted sealed worker does not write personal preferences or project knowledge candidates. Nothing from this capture payload was persisted; the checkpoint, work log and memory are unaffected. Return results to the coordinator; a human may capture knowledge later through an ordinary task.' };
}

export function taskCaptureStatus(receipts) {
  const disabled = receipts.filter(item => item.status === 'capture_disabled').length;
  if (disabled === receipts.length) return 'capture_disabled';
  if (disabled) return 'partial';
  return receipts.every(item => item.status === 'duplicate') ? 'duplicate' : 'committed';
}

// Links project the stored receipt into the existing knowledge inspector. The
// receipt contains IDs only; the Provider's knowledge records remain authoritative.
export function taskCaptureReviewPaths(spaceId, receipts) {
  if (!receipts) return undefined;
  return receipts.map(receipt => {
    const space = encodeURIComponent(spaceId), project = encodeURIComponent(receipt.personal_project_id ?? '');
    const base = receipt.scope === 'personal_global' ? `/knowledge/personal/${space}` : `/personal/${space}/projects/${project}`;
    const items = [...receipt.entity_ids.map(id => ['entity', id]), ...receipt.relationship_ids.map(id => ['relationship', id])];
    return { ...receipt, review_paths: items.slice(0, 3).map(([kind, id]) => `${base}/directory/${kind}/${encodeURIComponent(id)}`) };
  });
}
