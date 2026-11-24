import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';
import { entryRules, entryRulesReference } from './entry-rules.js';
import { taskPreferenceScope } from '../mcp/provider-task-context-registry.js';
import { preferenceInstructionView } from './preference-view.js';
import { TASK_SCENE_VERSION } from '../graphiti/task-scene.js';
import { preferenceSceneReplaceable } from '../graphiti/preference-task-scope.js';
import { indexEntryIsLine, preferenceIndexNames, preferenceName } from './preference-index.js';

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

// The scene (work kind, workflow) the producer persisted for this task, or
// null: what a frame's scopeHash holds beside its authority.
export function entryPreferenceScene(value) {
  return value?.[SCOPE]?.preference_scope ?? null;
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
// uncached result. `previous`: what the FLA before spelled out that does not
// apply here (previousAgentPreferences).
export function completePreferenceFrame(value, shown, previous = []) {
  return withPreviousAgent(withRevision(value, preferenceSnapshot(value), shown), previous);
}

// The complete frame, or a smaller delta or scene switch against `baseline`,
// the latest acknowledged frame of the session (preference-session.js).
// `shown` maps each revision the generation shows to the one set it names.
// `provisional`: the hashes of the frame the session was just given that the
// transcript does not record yet. It is the base only of this same set, which
// it then names by the revision that frame showed. `whole`: the snapshot of
// the whole entry, before an inline budget bounded it to `value`, so a
// complete frame can tell what is gone from what it only leaves out.
// `previous`: on a turn handed to another FLA (no baseline then), what the FLA
// before spelled out that does not apply here (previousAgentPreferences).
export function projectPreferenceDelta(value, baseline, shown, provisional = null, whole = null, previous = []) {
  const snapshot = preferenceSnapshot(value);
  if (!snapshot) return value;
  const plain = withPreferenceScope({ ...value, effective_preferences: snapshot.preferences }, value[SCOPE]);
  const full = withPreviousAgent(withRevision(plain, snapshot, shown), previous);
  const revision = full.revision;
  if (revision && provisional?.snapshotHash === snapshot.snapshotHash && provisional.scopeHash === snapshot.scopeHash) {
    baseline = { ...snapshot, revision, omittedIndex: null };
  }
  if (!revision || !baseline?.revision || baseline.authorityHash !== snapshot.authorityHash) return full;
  const complete = withGone(full, baseline, whole ?? snapshot);
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
    if (bounded || contentHash(boundaryUnits(baseline.units)) !== contentHash(boundaryUnits(snapshot.units))) return complete;
    return smaller(withPreferenceScope({ ...plain,
      effective_preferences: snapshot.preferences.filter(item => snapshot.units[unitId(item)].scene),
      preference_delivery: { status: 'scene_switch', supersedes: baseline.revision, revision, scene: sceneName(snapshot.scene),
        replaces: sceneKeys(baseline.units), ...DELIVERY_RULES() } }, value[SCOPE]), plain) ?? complete;
  }
  const updates = snapshot.preferences.filter(item => baseline.units[unitId(item)]?.hash !== snapshot.units[unitId(item)].hash);
  const removed = Object.entries(baseline.units).filter(([id]) => !Object.hasOwn(snapshot.units,id))
    .map(([,unit]) => unit.identity);
  if (bounded && removed.length) return complete;
  // A delta stays in its base's scene, so it does not repeat it. Nor does it
  // repeat an omission index the base already showed word for word (review of
  // #1070: at 60 preferences the second turn grew from 1329 to 1883 chars by
  // resending it); it says index_unchanged instead.
  // An index that only grew is sent as what it adds (index_added): resending
  // it whole at the keys tier, once its lines no longer fit, took back the
  // lines the model held and gave it less to judge by.
  const { effective_preferences, ...current } = plain;
  const index = omittedIndexChange(current.preferences_omitted?.index, baseline.omittedIndex, whole ?? snapshot, snapshot);
  if (index) {
    const { index: _index, ...omitted } = current.preferences_omitted;
    current.preferences_omitted = { ...omitted, ...index };
  }
  return smaller({ ...current, preference_updates: updates, preference_delivery: {
    status: 'delta', base_revision: baseline.revision, revision, removed, unchanged: snapshot.preferences.length - updates.length,
    ...DELIVERY_RULES() } }, plain) ?? complete;
}

// A complete frame replaces the set of the frames before it, but a body they
// showed is still in the conversation, and a complete frame carries no rule
// reference saying so. So a complete frame in place of a delta names, by key
// and layer, each preference of its base the whole entry no longer has, in a
// field whose name says what that means: preferences_removed for one deleted
// or disabled, preferences_out_of_scene for a scene item of a base in another
// scene (it applies again there). One it only leaves out under an inline
// budget is still in force and is not named.
function withGone(full, baseline, current) {
  const gone = Object.entries(baseline.units).filter(([id]) => !Object.hasOwn(current.units, id)).map(([, item]) => item);
  const away = item => baseline.scopeHash !== current.scopeHash && item.scene;
  const names = items => items.map(item => preferenceName(item.identity)).sort();
  const removed = names(gone.filter(item => !away(item))), outOfScene = names(gone.filter(away));
  return gone.length ? copyPreferenceScope(full, { ...full, ...(removed.length ? { preferences_removed: removed } : {}),
    ...(outOfScene.length ? { preferences_out_of_scene: outOfScene } : {}) }) : full;
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

// The source ID is delivered but is no instruction revision: a frame bounded
// without IDs proves the same set. A new version under a new ID (rec#75) that
// says the same thing needs no redelivery.
function unit({ id: _id, item_kind: _kind, ...item }) {
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

// What a session's base frame (preference-session.js) left the model holding,
// for an inline budget to keep (entry-inline-budget.js): `units`, what it
// spelled out, `index`, its omission index, or null where it named none,
// `owed`, the preferences added in this generation and scope within its quota
// that no frame has spelled out yet (owedPreferenceIds), `spent`, how much of
// that quota the generation has used, `known`, the preferences this scope
// of the generation already had in view without spelling them out (its first
// frame's whole set, and each added one a frame left to rank), and `grow`,
// whether this frame may spell out more than that.
export function heldPreferences(baseline, { grow = true, known = [] } = {}) {
  return { units: baseline.units, index: Array.isArray(baseline.omittedIndex) ? baseline.omittedIndex : null,
    owed: new Set(baseline.owed ?? []), spent: baseline.spent ?? 0, known: new Set(known), grow };
}

// Where a preference of this entry stood in the held base frame: 'listed'
// (spelled out as it is now), 'changed' (spelled out, changed since), 'indexed'
// (named in its omission index) or 'new' (never named: added, or now at
// another layer). One added in this generation stays 'new' until a frame
// spells it out, even once an index named it: an index only names what the
// first frame chose to leave out, and one the person added later is not that.
// One the scope already had in view (`known`) is 'indexed' too: a frame that
// only counts what it leaves out (no index) names nothing.
export function heldStatus(item, held) {
  const view = JSON.parse(canonicalJson(preferenceInstructionView(item), { omitUndefined: true }));
  const base = held.units[unitId(view)];
  if (base) return base.hash === unit(view).hash ? 'listed' : 'changed';
  if (heldOwes(item, held)) return 'new';
  return held.known?.has(owedId(view)) || held.index?.some(entry => preferenceIndexNames(entry, item)) ? 'indexed' : 'new';
}

// Whether a frame built on `held` still owes this preference's body.
export function heldOwes(item, held) {
  return Boolean(held.owed?.has(owedId(JSON.parse(canonicalJson(preferenceInstructionView(item), { omitUndefined: true })))));
}

// The short hashes the session record keeps for preferences of `value`, the
// whole entry, by their index in it (every one where `indexes` is omitted):
// key and layer only. It keeps those a frame still owes (entry-inline-budget.js
// heldFit), so a later frame still treats each as new, and those a scope
// already had in view (heldPreferences `known`).
export function preferenceIds(value, indexes = value.effective_preferences.map((_, index) => index)) {
  return [...new Set(indexes.map(index => owedId(JSON.parse(canonicalJson(
    preferenceInstructionView(value.effective_preferences[index]), { omitUndefined: true })))))].sort();
}

// A turn handed to another FLA (a workstream's owner, #1063) gets a complete
// frame, but the bodies the FLA before spelled out are still in the
// conversation. This names, by key and layer, each FLA-level preference of
// another FLA that `frames` (what the session was given since this FLA's own
// latest frame) spelled out and the whole entry `value` does not have.
export function previousAgentPreferences(value, frames) {
  const agent = value?.[SCOPE]?.project_agent_id;
  const current = preferenceSnapshot(value);
  if (!current) return [];
  const names = frames.flatMap(frame => [...(Array.isArray(frame?.effective_preferences) ? frame.effective_preferences : []),
    ...(Array.isArray(frame?.preference_updates) ? frame.preference_updates : [])])
    .filter(item => item?.preference_scope === 'agent' && item.preference_agent_id && item.preference_agent_id !== agent
      && typeof item.preference_key === 'string' && !Object.hasOwn(current.units, unitId(item)))
    .map(item => preferenceName(identity(item)));
  return [...new Set(names)].sort();
}

// The complete frame of a turn handed to another FLA, naming what the one
// before spelled out that does not apply here; only where there is any.
function withPreviousAgent(frame, names) {
  return names?.length ? copyPreferenceScope(frame, { ...frame, preferences_of_previous_agent: names }) : frame;
}

function owedId(view) { return contentHash(unitId(view)).slice(0, OWED_HEX); }
const OWED_HEX = 16;
export const OWED_ID = /^[0-9a-f]{16}$/;

// The omission index a recorded frame left the model holding: the one it
// carries, or, for a delta that said index_unchanged, the one its base held
// with what it added (index_added; a later entry for the same preference
// stands over an earlier one). null when it carried none.
export function frameOmittedIndex(frame, shown) {
  const omitted = frame?.preferences_omitted;
  if (Array.isArray(omitted?.index)) return omitted.index;
  const delivery = frame?.preference_delivery;
  if (omitted?.index_unchanged === true && delivery?.status === 'delta') {
    const held = shown.get(delivery.base_revision)?.omittedIndex;
    if (!Array.isArray(held)) return null;
    return Array.isArray(omitted.index_added) ? [...held, ...omitted.index_added] : held;
  }
  return null;
}

// What a delta says of its omission index against the one its base left the
// model holding (`held`): `index_unchanged` where every entry it would send is
// held already, with `index_added` for the rest. An entry is held when the
// same text is, or, for a key alone, when a held entry names that preference
// (a held line says more than its key). Null where the index is sent whole: an
// index on neither side, a held entry for a preference that is neither left
// out nor spelled out now (deleted: the model must not keep it), or where the
// whole index is no larger. `whole` is the entry's whole snapshot, so a key
// can be told by its layer; `delivered` is the set this frame spells out.
function omittedIndexChange(index, held, whole, delivered) {
  if (!Array.isArray(index) || !index.length || !Array.isArray(held) || !held.length) return null;
  if (canonicalJson(index) === canonicalJson(held)) return { index_unchanged: true };
  const identities = Object.values(whole.units).map(item => item.identity);
  const named = entry => identities.filter(item => preferenceIndexNames(entry, item)).map(unitId);
  const listed = new Set(index.flatMap(named));
  if (held.some(entry => !named(entry).some(id => listed.has(id) || Object.hasOwn(delivered.units, id)))) return null;
  const heldText = new Set(held);
  const heldIds = new Set(held.flatMap(named));
  const added = index.filter(entry => !heldText.has(entry) && (indexEntryIsLine(entry) || !named(entry).some(id => heldIds.has(id))));
  const change = { index_unchanged: true, ...(added.length ? { index_added: added } : {}) };
  return Buffer.byteLength(JSON.stringify(change)) < Buffer.byteLength(JSON.stringify({ index })) ? change : null;
}
