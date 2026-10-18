import { canonicalJson, contentHash } from '../publication/canonical-json.js';
import { entryRules } from './entry-rules.js';
import { taskPreferenceScope } from '../mcp/provider-task-context-registry.js';
import { preferenceInstructionView } from './preference-view.js';

const SCOPE = Symbol('fuli.authoritativePreferenceScope');
const IDENTITY = ['preference_key', 'preference_scope', 'preference_project_id',
  'preference_agent_id', 'inherited_from_project_id'];
const DELTA_GUIDANCE = 'Apply these updates and removals to the named complete tool result in this same context generation. '
  + 'If that base is unavailable, call read_task_preferences with the current taskContextToken. '
  + 'Keep current identity, authority and conflicts; this cache grants no permission.';

// Only the Provider-backed task producer supplies this private metadata.
// JSON, model tool arguments and copied transcript records cannot forge it.
export function withPreferenceScope(value, scope) {
  return Object.defineProperty({ ...value }, SCOPE, { value: scope });
}

export function copyPreferenceScope(value, target) {
  return value?.[SCOPE] ? withPreferenceScope(target, value[SCOPE]) : target;
}

export function taskPreferenceMetadata(task, personalSpaceId) {
  return { personal_space_id: personalSpaceId, personal_project_id: task.personalProjectId,
    project_agent_id: task.projectAgentId, session_id: task.sessionId,
    source_application: task.sourceApplication, preference_scope: task.preferenceScope };
}

export function preferenceSnapshot(value) {
  const scope = value?.[SCOPE];
  if (!scope?.personal_space_id || !scope.project_agent_id || !Object.hasOwn(scope, 'personal_project_id')
      || !scope.source_application || !scope.session_id
      || scope.session_id.startsWith('fuli-host-') || !validScope(scope.preference_scope) || value.preferences_complete === false
      || value.preference_delivery?.status === 'paginated'
      || value.context?.source_truncated || value.worker_run || !Array.isArray(value.effective_preferences)
      || !value.taskContextToken) return null;
  if (value.effective_preferences.some(item => !item?.preference_key || !item.preference_scope || typeof item.instruction !== 'string')) return null;
  const items = value.effective_preferences.map(item => JSON.parse(canonicalJson(
    preferenceInstructionView(item), { omitUndefined: true })));
  const scopeHash = contentHash({ scope, rules: entryRules().version });
  const units = {}, preferences = [...items].sort((a,b) => unitId(a).localeCompare(unitId(b)));
  for (const item of preferences) {
    const id = unitId(item);
    if (Object.hasOwn(units, id)) return null;
    units[id] = { hash: contentHash(JSON.parse(canonicalJson(item, { omitUndefined: true }))), identity: identity(item) };
  }
  return { scopeHash, snapshotHash: contentHash({ scopeHash, units }), units, preferences,
    sessionId: scope.session_id, sourceApplication: scope.source_application };
}

export function projectPreferenceDelta(value, baseline) {
  const snapshot = preferenceSnapshot(value);
  if (!snapshot) return value;
  const full = withPreferenceScope({ ...value, effective_preferences: snapshot.preferences }, value[SCOPE]);
  if (!baseline?.callId || baseline.scopeHash !== snapshot.scopeHash) return full;
  const updates = snapshot.preferences.filter(item => baseline.units[unitId(item)]?.hash !== snapshot.units[unitId(item)].hash);
  const removed = Object.entries(baseline.units).filter(([id]) => !Object.hasOwn(snapshot.units,id))
    .map(([,unit]) => unit.identity);
  const { effective_preferences, ...current } = full;
  const delta = { ...current, preference_updates: updates, preference_delivery: {
    status: 'delta', base_revision: baseline.snapshotHash, revision: snapshot.snapshotHash,
    base_result: baseline.callId, removed, unchanged: snapshot.preferences.length - updates.length,
    guidance: DELTA_GUIDANCE } };
  return Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(full)) ? delta : full;
}

// Reconstruct only instruction fingerprints from an actually delivered delta.
// The producer's private pending hash must still match this whole native frame.
export function applyPreferenceDeltaSnapshot(value, baseline) {
  const delivery = value?.preference_delivery;
  if (!baseline || delivery?.status !== 'delta' || delivery.base_result !== baseline.callId
      || delivery.base_revision !== baseline.snapshotHash || !Array.isArray(delivery.removed)
      || !Array.isArray(value.preference_updates)) return null;
  const units = structuredClone(baseline.units);
  for (const item of delivery.removed) delete units[unitId(item)];
  for (const item of value.preference_updates) {
    if (!item?.preference_key || typeof item.instruction !== 'string') return null;
    const projected = JSON.parse(canonicalJson(preferenceInstructionView(item), { omitUndefined: true }));
    units[unitId(item)] = { hash: contentHash(projected), identity: identity(item) };
  }
  const snapshotHash = contentHash({ scopeHash: baseline.scopeHash, units });
  return snapshotHash === delivery.revision ? { ...baseline, units, snapshotHash } : null;
}

function validScope(value) {
  try { return Boolean(taskPreferenceScope(value)); } catch { return false; }
}

function identity(item) {
  return Object.fromEntries(IDENTITY.map(key => [key, item[key] ?? null]));
}

function unitId(item) { return canonicalJson(identity(item)); }
