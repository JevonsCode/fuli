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
// The model finds a delta's or scene switch's base by the short revision that
// frame shows (rec#15 D-29.3): the first 12 hex of its snapshot hash, longer
// while another frame of the context generation shows that string for another
// set or for one FULI cannot verify (D-29.9). The host still verifies the
// whole snapshot and frame hashes it keeps privately.
const REVISION_HEX = 12;
const REVISION_STEP = 4;
const REVISION = /^[0-9a-f]{12,64}$/;

// Only the Provider-backed task producer supplies this private metadata.
// JSON, model tool arguments and copied transcript records cannot forge it.
export function withPreferenceScope(value, scope) {
  return Object.defineProperty({ ...value }, SCOPE, { value: scope });
}

export function copyPreferenceScope(value, target) {
  return value?.[SCOPE] ? withPreferenceScope(target, value[SCOPE]) : target;
}

// An earlier native frame under the current authorized scope, read in the
// scene its producer kept privately beside the pending hash (rec#15 D-29.2).
// A frame never declares its own scene, so a copy cannot claim another one.
export function framePreferenceSnapshot(value, frame, scene) {
  const scope = value?.[SCOPE];
  return scope ? preferenceSnapshot(withPreferenceScope(frame, { ...scope,
    preference_scope: { version: 1, work_kind: scene.work_kind, workflow: scene.workflow } })) : null;
}

// The work kind the producer persisted for this task, or null.
export function entryWorkKind(value) {
  return value?.[SCOPE]?.preference_scope?.work_kind ?? null;
}

// The scene a pending record keeps for the frame it was produced as.
export function pendingScene(snapshot) {
  return { work_kind: snapshot.scene.work_kind ?? null, workflow: snapshot.scene.workflow ?? null, table: TASK_SCENE_VERSION };
}

// A pending record without a scene (written before D-29.2) or from another
// scene table confirms nothing; its frame is delivered in full again.
export function confirmableScene(scene) {
  return scene?.table === TASK_SCENE_VERSION;
}

// The preference revision a frame shows the model: a complete frame's own
// `revision`, or a delta's or scene switch's preference_delivery.revision.
export function shownRevision(frame) {
  const delivery = frame?.preference_delivery;
  const revision = ['delta', 'scene_switch'].includes(delivery?.status) ? delivery.revision : frame?.revision;
  return typeof revision === 'string' && REVISION.test(revision) ? revision : null;
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

// A complete result as it is, plus the revision a later delta can name.
// `shown` is null when this session can never confirm the frame, and an empty
// set (outside a bounded frame) never needs a base: both stay exactly the
// uncached result.
export function completePreferenceFrame(value, shown) {
  return withRevision(value, preferenceSnapshot(value), shown);
}

// The complete frame, or a smaller delta or scene switch against `baseline`,
// the latest acknowledged frame of the session (preference-session.js).
// `shown` maps each revision the generation shows to the one set it names.
export function projectPreferenceDelta(value, baseline, shown) {
  const snapshot = preferenceSnapshot(value);
  if (!snapshot) return value;
  const plain = withPreferenceScope({ ...value, effective_preferences: snapshot.preferences }, value[SCOPE]);
  const full = withRevision(plain, snapshot, shown);
  const revision = full.revision;
  if (!revision || !baseline?.revision || baseline.authorityHash !== snapshot.authorityHash) return full;
  // A frame bounded to an inline budget (entry-inline-budget.js, D-54) lists
  // only the set it delivers; what it leaves out may still be in force. So it
  // never names a removal or takes back a scene's items: it is a delta that
  // only adds or changes, or a complete frame.
  const bounded = Object.hasOwn(value, 'preferences_omitted');
  // Same space, project, Agent, client and session in another scene: only the
  // scene-replaceable set is listed and replaced (D-27.8). Boundaries and hard
  // constraints stay as delivered; if one of them changed too, a complete
  // frame is sent instead.
  if (baseline.scopeHash !== snapshot.scopeHash) {
    if (bounded || contentHash(boundaryUnits(baseline.units)) !== contentHash(boundaryUnits(snapshot.units))) return full;
    return smaller(withPreferenceScope({ ...plain,
      effective_preferences: snapshot.preferences.filter(item => snapshot.units[unitId(item)].scene),
      preference_delivery: { status: 'scene_switch', supersedes: baseline.revision, revision, scene: sceneName(snapshot.scene),
        replaces: sceneKeys(baseline.units), ...DELIVERY_RULES() } }, value[SCOPE]), plain) ?? full;
  }
  const updates = snapshot.preferences.filter(item => baseline.units[unitId(item)]?.hash !== snapshot.units[unitId(item)].hash);
  const removed = Object.entries(baseline.units).filter(([id]) => !Object.hasOwn(snapshot.units,id))
    .map(([,unit]) => unit.identity);
  if (bounded && removed.length) return full;
  // A delta stays in its base's scene, so it does not repeat it.
  const { effective_preferences, ...current } = plain;
  return smaller({ ...current, preference_updates: updates, preference_delivery: {
    status: 'delta', base_revision: baseline.revision, revision, removed, unchanged: snapshot.preferences.length - updates.length,
    ...DELIVERY_RULES() } }, plain) ?? full;
}

// Reconstruct only instruction fingerprints from an actually delivered delta
// on the base its base_revision names. The producer's private pending hash
// must still match this whole native frame.
export function applyPreferenceDeltaSnapshot(value, base) {
  const delivery = value?.preference_delivery;
  if (!base?.units || delivery?.status !== 'delta' || delivery.base_revision !== base.revision
      || !Array.isArray(delivery.removed) || !Array.isArray(value.preference_updates)) return null;
  const units = structuredClone(base.units);
  for (const item of delivery.removed) delete units[unitId(item)];
  for (const item of value.preference_updates) {
    if (!item?.preference_key || typeof item.instruction !== 'string') return null;
    units[unitId(item)] = unit(JSON.parse(canonicalJson(preferenceInstructionView(item), { omitUndefined: true })));
  }
  return { scopeHash: base.scopeHash, authorityHash: base.authorityHash, units,
    snapshotHash: contentHash({ scopeHash: base.scopeHash, units }) };
}

// A delivered scene switch lists only replaceable items; the base's boundaries
// and hard constraints carry over. The pending hash still binds the whole frame.
export function applySceneSwitchSnapshot(value, frame, base, scene) {
  const delivery = frame?.preference_delivery;
  if (!base?.units || delivery?.status !== 'scene_switch' || delivery.supersedes !== base.revision
      || canonicalJson(delivery.replaces ?? null) !== canonicalJson(sceneKeys(base.units))) return null;
  const listed = framePreferenceSnapshot(value, frame, scene);
  if (!listed || Object.values(listed.units).some(item => !item.scene)) return null;
  const units = { ...boundaryUnits(base.units), ...listed.units };
  return { ...listed, units, snapshotHash: contentHash({ scopeHash: listed.scopeHash, units }) };
}

// An empty set needs no base, except in a bounded frame that leaves every
// preference out (rec#11 D-72): its revision is the base the next delta names.
function withRevision(value, snapshot, shown) {
  const based = snapshot?.preferences.length || Object.hasOwn(value, 'preferences_omitted');
  const revision = shown && based ? uniqueRevision(snapshot.snapshotHash, shown) : null;
  return revision ? withPreferenceScope({ ...value, revision }, value[SCOPE]) : value;
}

function uniqueRevision(hash, shown) {
  for (let length = REVISION_HEX; length <= hash.length; length += REVISION_STEP) {
    const revision = hash.slice(0, length), other = shown.get(revision);
    if (!other || other.snapshotHash === hash) return revision;
  }
  return null;
}

// A delta or scene switch only where it is smaller than the uncached frame.
function smaller(candidate, plain) {
  return Buffer.byteLength(JSON.stringify(candidate)) < Buffer.byteLength(JSON.stringify(plain)) ? candidate : null;
}

// The one model-facing trace of the scene (D-29.2).
function sceneName(scene) {
  return [scene.work_kind, scene.workflow].filter(Boolean).join('/') || null;
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
