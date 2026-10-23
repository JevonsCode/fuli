import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { entryRules, entryRulesReference } from './entry-rules.js';
import { taskPreferenceScope } from '../mcp/provider-task-context-registry.js';
import { preferenceInstructionView } from './preference-view.js';
import { TASK_SCENE_VERSION } from '../graphiti/task-scene.js';
import { preferenceSceneReplaceable } from '../graphiti/preference-task-scope.js';

const SCOPE = Symbol('fuli.authoritativePreferenceScope');
const IDENTITY = ['preference_key', 'preference_scope', 'preference_project_id',
  'preference_agent_id', 'inherited_from_project_id'];
// The rule text is in entry-rules.js; a frame names it, so one short added
// rule costs one update, not a repeated paragraph.
const DELIVERY_RULES = () => entryRulesReference('preference_delivery');

// Only the Provider-backed task producer supplies this private metadata.
// JSON, model tool arguments and copied transcript records cannot forge it.
export function withPreferenceScope(value, scope) {
  return Object.defineProperty({ ...value }, SCOPE, { value: scope });
}

export function copyPreferenceScope(value, target) {
  return value?.[SCOPE] ? withPreferenceScope(target, value[SCOPE]) : target;
}

// An earlier native frame under the current authorized scope and the scene it
// declares. The pending hash its producer kept still has to match: a frame
// whose declared scene was not the one it was produced for never verifies.
// A frame without a declared scene (a full reader result) keeps the current one.
export function framePreferenceSnapshot(value, frame) {
  const scope = value?.[SCOPE];
  const scene = frame?.preference_scene;
  return preferenceSnapshot(withPreferenceScope(frame, scope && scene ? { ...scope,
    preference_scope: { version: 1, work_kind: scene.work_kind ?? null, workflow: scene.workflow ?? null } } : scope));
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
  const { preference_scope: scene, ...authority } = scope;
  const rules = entryRules().version;
  const scopeHash = contentHash({ scope, rules });
  const units = {}, preferences = [...items].sort((a,b) => unitId(a).localeCompare(unitId(b)));
  for (const item of preferences) {
    const id = unitId(item);
    if (Object.hasOwn(units, id)) return null;
    units[id] = unit(item);
  }
  return { scopeHash, authorityHash: contentHash({ authority, rules }), scene, snapshotHash: contentHash({ scopeHash, units }),
    units, preferences, sessionId: scope.session_id, sourceApplication: scope.source_application };
}

export function projectPreferenceDelta(value, baseline) {
  const snapshot = preferenceSnapshot(value);
  if (!snapshot) return value;
  const full = withPreferenceScope({ ...value, effective_preferences: snapshot.preferences,
    preference_scene: { work_kind: snapshot.scene.work_kind, workflow: snapshot.scene.workflow, table: TASK_SCENE_VERSION } }, value[SCOPE]);
  if (!baseline?.callId || baseline.authorityHash !== snapshot.authorityHash) return full;
  // Same space, project, Agent, client and session in another scene: only the
  // scene-replaceable set is listed and replaced (D-27.8). Boundaries and hard
  // constraints stay as delivered; if one of them changed too, a complete
  // frame is sent instead.
  if (baseline.scopeHash !== snapshot.scopeHash) {
    if (contentHash(boundaryUnits(baseline.units)) !== contentHash(boundaryUnits(snapshot.units))) return full;
    return withPreferenceScope({ ...full,
      effective_preferences: snapshot.preferences.filter(item => snapshot.units[unitId(item)].scene),
      preference_delivery: { status: 'scene_switch', supersedes: baseline.snapshotHash, base_result: baseline.callId,
        revision: snapshot.snapshotHash, replaces: sceneKeys(baseline.units), ...DELIVERY_RULES() } }, value[SCOPE]);
  }
  const updates = snapshot.preferences.filter(item => baseline.units[unitId(item)]?.hash !== snapshot.units[unitId(item)].hash);
  const removed = Object.entries(baseline.units).filter(([id]) => !Object.hasOwn(snapshot.units,id))
    .map(([,unit]) => unit.identity);
  // A delta stays in its base's scene, so it does not repeat it.
  const { effective_preferences, preference_scene, ...current } = full;
  const delta = { ...current, preference_updates: updates, preference_delivery: {
    status: 'delta', base_revision: baseline.snapshotHash, revision: snapshot.snapshotHash,
    base_result: baseline.callId, removed, unchanged: snapshot.preferences.length - updates.length,
    ...DELIVERY_RULES() } };
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
    units[unitId(item)] = unit(JSON.parse(canonicalJson(preferenceInstructionView(item), { omitUndefined: true })));
  }
  const snapshotHash = contentHash({ scopeHash: baseline.scopeHash, units });
  return snapshotHash === delivery.revision ? { ...baseline, units, snapshotHash } : null;
}

// A delivered scene switch lists only replaceable items; the base's boundaries
// and hard constraints carry over. The pending hash still binds the whole frame.
export function applySceneSwitchSnapshot(value, frame, baseline) {
  const delivery = frame?.preference_delivery;
  if (!baseline || delivery?.status !== 'scene_switch' || delivery.base_result !== baseline.callId
      || delivery.supersedes !== baseline.snapshotHash
      || canonicalJson(delivery.replaces ?? null) !== canonicalJson(sceneKeys(baseline.units))) return null;
  const listed = framePreferenceSnapshot(value, frame);
  if (!listed || Object.values(listed.units).some(item => !item.scene)) return null;
  const units = { ...boundaryUnits(baseline.units), ...listed.units };
  const snapshotHash = contentHash({ scopeHash: listed.scopeHash, units });
  return snapshotHash === delivery.revision ? { ...listed, units, snapshotHash } : null;
}

function unit(item) {
  return { hash: contentHash(JSON.parse(canonicalJson(item, { omitUndefined: true }))), identity: identity(item),
    scene: preferenceSceneReplaceable(item) };
}

// The keys a scene switch takes back: the base's whole replaceable set.
function sceneKeys(units) {
  return [...new Set(Object.values(units).filter(item => item.scene).map(item => item.identity.preference_key))].sort();
}

function boundaryUnits(units) {
  return Object.fromEntries(Object.entries(units).filter(([, item]) => !item.scene));
}

function validScope(value) {
  try { return Boolean(taskPreferenceScope(value)); } catch { return false; }
}

function identity(item) {
  return Object.fromEntries(IDENTITY.map(key => [key, item[key] ?? null]));
}

function unitId(item) { return canonicalJson(identity(item)); }
