import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';

// The task-entry skeleton (rec#76): what stays the same from turn to turn of
// one session. A hook frame leaves out each part that an earlier frame of this
// context generation showed exactly so, and names that frame by its
// skeleton_revision, so the model never has to guess which earlier frame is
// meant. The token, checkpoint requirement, preferences, conflicts and the
// recovered messages are never part of it: they have their own deltas.
// A dotted part is a path inside the frame: the conversation's rule reference
// and the latest saved result of its conversation, which repeats while no task
// records a new one (rec#15).
const SKELETON_PARTS = Object.freeze(['agent_receipt', 'task_guidance', 'application_guidance', 'checkpoint_guidance',
  'project_agent_context', 'project_management_context', 'judgment_context', 'context', 'task_knowledge_recall',
  'conversation.guidance', 'conversation.recovery.latest_checkpoint']);
// Parts compared field by field (rec#88): a new prompt changes a few of their
// fields (the recall's categories, the Agent's match basis) and leaves the
// rest (the same recalled items, the role, the brief, the memory) as before.
const FIELD_PARTS = new Set(['project_agent_context', 'task_knowledge_recall']);
// The hook's own instructions above the frame, as the host recorded them.
export const SKELETON_LABEL = 'label';
export const SKELETON_UNCHANGED_LABEL = 'skeleton_unchanged: parts not repeated here, as earlier FULI frames gave them, by skeleton_revision '
  + '(later wins, this frame\'s own first; a map lists parts; null = no longer present; label = text above the JSON).';
const HASH = /^[a-f0-9]{64}$/;
const MAX_SKELETON_TASKS = 16;
const NO_BASES = Object.freeze({ bases: Object.freeze([]) });

// The instructions shown above a frame: the hook's label, or only the
// skeleton sentence when the frame names an earlier one for it.
export function skeletonFrameLabel(label, frame) {
  if (!frame?.skeleton_unchanged) return label;
  return namesLabel(frame) ? SKELETON_UNCHANGED_LABEL : `${label} ${SKELETON_UNCHANGED_LABEL}`;
}

// Revisions whose parts all apply always include the label; a map names it.
function namesLabel(frame) {
  const unchanged = frame.skeleton_unchanged;
  return typeof unchanged === 'string' || Array.isArray(unchanged) || Object.values(unchanged ?? {}).flat().includes(SKELETON_LABEL);
}

// The earlier frames one delivery of `value` may name, oldest first, each with
// everything it gave: its own parts over those it named itself. A frame of
// this generation is a base only when the host recorded it, its own
// skeleton_revision matches what it shows (fields, label and the frames it
// names), whatever it names resolves to a base before it, and it belongs to
// this owner: the same token (a host notification refreshed in place; a
// task never changes project or Agent) or any task this session began in the
// same project for the same Agent (rec#88: every prompt of a session is a new
// task, and its skeleton is mostly the one already shown). Another project or
// Agent, or anything after a compaction or reset (floor), has no base and
// gets the whole skeleton.
export function skeletonEvidence(proof, value, { floor, tasks, prompt }) {
  if (!proof.known || floor === null || typeof prompt !== 'string') return NO_BASES;
  const begun = new Map(tasks);
  const owner = skeletonOwnerHash(value);
  const sameOwner = token => token === value.taskContextToken || begun.get(skeletonTokenHash(token)) === owner;
  const given = new Map();
  const bases = [];
  for (const { confirms, offset, visible, label } of proof.frames) {
    if (!confirms || offset < floor || typeof visible?.taskContextToken !== 'string'
      || visible.skeleton_revision !== skeletonRevision(visible, labelPart(label))) continue;
    const named = namedParts(visible.skeleton_unchanged, given);
    if (!named) continue;
    const parts = { ...named, ...delivered(skeletonParts(visible)),
      ...(labelPart(label) === null ? {} : { [SKELETON_LABEL]: labelPart(label) }) };
    if (!given.has(visible.skeleton_revision)) given.set(visible.skeleton_revision, parts);
    if (sameOwner(visible.taskContextToken)) bases.push({ revision: visible.skeleton_revision, parts });
  }
  return { bases };
}

// What a frame's skeleton_unchanged gives, from the frames before it, or null
// when one of them is not known.
function namedParts(unchanged, given) {
  if (unchanged === undefined) return {};
  if (typeof unchanged === 'string' || Array.isArray(unchanged)) {
    const frames = [unchanged].flat().map(revision => given.get(revision));
    return frames.every(Boolean) ? Object.assign({}, ...frames) : null;
  }
  const parts = {};
  for (const [revision, names] of Object.entries(unchanged ?? {})) {
    const frame = given.get(revision);
    if (!frame || !Array.isArray(names) || !names.every(name => Object.hasOwn(frame, name))) return null;
    for (const name of names) parts[name] = frame[name];
  }
  return parts;
}

// The frame to send for `value` under the hook's `label` (a function of the
// frame): each skeleton part an eligible base shows exactly so is left out
// and named by the latest such base; what is still sent carries its own
// skeleton_revision. When what the bases gave, applied oldest first, gives
// exactly the parts left out, label included, they are named by revision
// alone (a bare one for a single base); otherwise each part is named under
// its base. A part the bases gave that this frame no longer has is sent as
// null, so their revisions still apply whole. The complete frame is sent when
// that is no larger.
// `evidence` null means this delivery can never be confirmed, so it carries
// no revision. An incomplete or blocked frame keeps its whole skeleton under
// its own label: it is never a base and names none.
export function projectSkeleton(value, evidence, label) {
  const own = delivered(skeletonParts(value));
  if (!evidence || !Object.keys(own).length || value.preferences_complete === false) return value;
  const parts = { [SKELETON_LABEL]: label(value), ...own };
  const from = {};
  for (const part of Object.keys(parts)) {
    const base = evidence.bases.findLast(item => Object.hasOwn(item.parts, part)
      && canonicalJson(item.parts[part]) === canonicalJson(parts[part]));
    if (base) (from[base.revision] ??= []).push(part);
  }
  const complete = withRevision(value, label);
  if (!Object.keys(from).length) return complete;
  const bare = bareNames(evidence.bases, from, parts, value);
  const left = new Set(Object.values(bare?.from ?? from).flat());
  const named = !bare ? from : bare.chain.length === 1 ? bare.chain[0][0] : bare.chain.map(([revision]) => revision);
  const kept = withoutParts(value, [...left].filter(part => part !== SKELETON_LABEL));
  const trimmed = withRevision({ ...(bare ? withNullParts(kept, bare.cleared) : kept), skeleton_unchanged: named }, label);
  return frameBytes(trimmed, label) < frameBytes(complete, label) ? trimmed : complete;
}

// Revisions alone name the parts left out when the bases they name, applied
// oldest first, give exactly those parts, label included. A part an older base
// gives as this frame has it, but a later one of the chain overrides, is sent
// instead of named, until the chain agrees. A part the chain gives that this
// frame no longer has is cleared to null where it can be. Null when the label
// or such a part cannot be named this way: each part is then named by its base.
function bareNames(bases, from, parts, value) {
  let named = from;
  for (;;) {
    const chain = [...new Map(bases.filter(item => Object.hasOwn(named, item.revision))
      .map(item => [item.revision, item.parts])).entries()];
    const resolved = Object.assign({}, ...chain.map(([, partsOf]) => partsOf));
    const overridden = new Set(Object.values(named).flat()
      .filter(part => canonicalJson(resolved[part]) !== canonicalJson(parts[part])));
    if (overridden.has(SKELETON_LABEL)) return null;
    if (overridden.size) {
      named = Object.fromEntries(Object.entries(named).map(([revision, names]) => [revision, names.filter(part => !overridden.has(part))])
        .filter(([, names]) => names.length));
      continue;
    }
    const gone = Object.keys(resolved).filter(part => !Object.hasOwn(parts, part));
    if (!Object.values(named).flat().includes(SKELETON_LABEL) || !gone.every(part => clearable(value, part))) return null;
    return { from: named, chain, cleared: gone.filter(part => resolved[part] !== null) };
  }
}

function skeletonTokenHash(token) {
  return contentHash({ purpose: 'skeleton-task-token-v1', token });
}

function skeletonOwnerHash(value) {
  return contentHash({ purpose: 'skeleton-task-owner-v1', project: value.context?.personal_project_id ?? null,
    agent: value.context?.project_agent_id ?? null });
}

// The project and Agent of each task a hook delivered here, by hash only,
// newest last: [token, owner].
export function rememberSkeletonTask(tasks, value, prompt) {
  if (typeof prompt !== 'string' || typeof value.taskContextToken !== 'string') return tasks;
  const key = skeletonTokenHash(value.taskContextToken);
  if (tasks.some(([tokenHash]) => tokenHash === key)) return tasks;
  return [...tasks, [key, skeletonOwnerHash(value)]].slice(-MAX_SKELETON_TASKS);
}

// A record version 3 kept [token, prompt, owner] as `prompts`; only the
// token and owner are read now. Anything else is no valid list.
export function skeletonTasks(value) {
  if (!Array.isArray(value) || value.length > MAX_SKELETON_TASKS || !value.every(item => Array.isArray(item)
    && [2, 3].includes(item.length) && item.every(hash => HASH.test(hash)))) return null;
  return value.map(item => [item[0], item.at(-1)]);
}

// A frame that still shows a skeleton field names it, with the label it
// shows in its own words, by revision.
function withRevision(frame, label) {
  return Object.keys(skeletonParts(frame)).length
    ? { ...frame, skeleton_revision: skeletonRevision(frame, namesLabel(frame) ? null : label(frame)) } : frame;
}

// The hook's own label of a recorded frame: its text without the skeleton
// sentence, or null when it names an earlier frame's label or has none.
function labelPart(text) {
  if (typeof text !== 'string' || text === SKELETON_UNCHANGED_LABEL) return null;
  const suffix = ` ${SKELETON_UNCHANGED_LABEL}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

function skeletonRevision(frame, label) {
  return contentHash({ purpose: 'task-entry-skeleton-v4', skeleton: delivered(skeletonParts(frame)), label,
    named: frame.skeleton_unchanged ?? null }).slice(0, 12);
}

// The frame's skeleton by part: a field part (FIELD_PARTS) by each of its
// fields, every other part whole.
export function skeletonParts(value) {
  return Object.fromEntries(SKELETON_PARTS.flatMap(part => {
    const item = partOf(value, part);
    if (item === undefined) return [];
    return FIELD_PARTS.has(part) && byField(item)
      ? Object.entries(item).filter(([, field]) => field !== undefined).map(([key, field]) => [`${part}.${key}`, field])
      : [[part, item]];
  }));
}

function byField(item) {
  return isObject(item) && Object.values(item).some(field => field !== undefined) && Object.keys(item).every(key => !key.includes('.'));
}

function isObject(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item);
}

function partOf(value, part) {
  return part.split('.').reduce((item, key) => item?.[key], value);
}

// The value without these parts, copying only the objects on their paths. An
// object left with no defined field is left out too.
function withoutParts(value, parts) {
  const result = { ...value };
  for (const part of parts) {
    const [key, ...rest] = part.split('.');
    const inner = rest.length ? withoutParts(result[key], [rest.join('.')]) : null;
    if (inner && Object.values(inner).some(item => item !== undefined)) result[key] = inner;
    else delete result[key];
  }
  return result;
}

// A part this frame no longer has can be sent as null when it is a part of
// its own or its parent is still an object of the frame.
function clearable(value, part) {
  const path = part.split('.');
  return path.length === 1 || isObject(partOf(value, path.slice(0, -1).join('.')));
}

function withNullParts(value, parts) {
  const result = { ...value };
  for (const part of parts) {
    const [key, ...rest] = part.split('.');
    result[key] = rest.length ? withNullParts(result[key], [rest.join('.')]) : null;
  }
  return result;
}

// The fields as the frame delivers them: JSON drops undefined.
function delivered(skeleton) {
  return JSON.parse(JSON.stringify(skeleton));
}

function frameBytes(frame, label) {
  return Buffer.byteLength(skeletonFrameLabel(label(frame), frame)) + Buffer.byteLength(JSON.stringify(frame));
}
