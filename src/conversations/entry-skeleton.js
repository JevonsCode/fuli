import { canonicalJson, contentHash } from '../../packages/roundtable/src/canonical-json.js';

// The task-entry skeleton (rec#76): what stays the same from turn to turn of
// one task. A hook frame leaves out each part that an earlier frame of this
// context generation showed exactly so, and names that frame by its
// skeleton_revision, so the model never has to guess which earlier frame is
// meant. The token, checkpoint requirement, preferences, conflicts and the
// recovered conversation are never part of it: they have their own deltas.
// `context` and `task_knowledge_recall` repeat byte for byte only when the
// same prompt does.
export const SKELETON_FIELDS = Object.freeze(['agent_receipt', 'task_guidance', 'application_guidance', 'checkpoint_guidance',
  'project_agent_context', 'project_management_context', 'judgment_context', 'context', 'task_knowledge_recall']);
// The hook's own instructions above the frame, as the host recorded them.
export const SKELETON_LABEL = 'label';
export const SKELETON_UNCHANGED_LABEL = 'skeleton_unchanged: parts left out, as earlier FULI frames gave them, by skeleton_revision: '
  + 'revision(s) whose parts apply, later over earlier, under this frame\'s own, or a map revision → parts (label: the text above the JSON).';
const HASH = /^[a-f0-9]{64}$/;
export const MAX_SKELETON_PROMPTS = 16;
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

// The earlier frames one delivery of `value` may name, oldest first. A frame
// of this generation is a base only when the host recorded it, its own
// skeleton_revision matches what it shows (fields and label), and it belongs
// to this task: the same token (a host notification refreshed in place; a
// task never changes project or Agent) or a task begun here with this exact
// prompt in the same project for the same Agent (a repeated prompt). A new
// task, another project or Agent, or anything after a compaction (floor) has
// no base and gets the whole skeleton.
export function skeletonEvidence(proof, value, { floor, prompts, prompt }) {
  if (!proof.known || floor === null || typeof prompt !== 'string') return NO_BASES;
  const begun = new Map(prompts.map(([token, ...task]) => [token, task.join()]));
  const repeated = [skeletonPromptHash(prompt), skeletonOwnerHash(value)].join();
  const sameTask = token => token === value.taskContextToken || begun.get(skeletonTokenHash(token)) === repeated;
  return { bases: proof.frames.filter(({ confirms, offset, visible, label }) => confirms && offset >= floor
    && typeof visible?.taskContextToken === 'string' && sameTask(visible.taskContextToken)
    && visible.skeleton_revision === skeletonRevision(visible, labelPart(label)))
    .map(({ visible, label }) => ({ revision: visible.skeleton_revision, parts: { ...delivered(skeletonOf(visible)),
      ...(labelPart(label) === null ? {} : { [SKELETON_LABEL]: labelPart(label) }) } })) };
}

// The frame to send for `value` under the hook's `label` (a function of the
// frame): each skeleton part an eligible base shows exactly so is left out
// and named by the latest such base; what is still sent carries its own
// skeleton_revision. When the bases' own parts, applied oldest first, give
// exactly the parts left out, label included, they are named by revision
// alone (a bare one for a single base); otherwise each part is named under
// its base. The complete frame is sent when that is no larger.
// `evidence` null means this delivery can never be confirmed, so it carries
// no revision. An incomplete or blocked frame keeps its whole skeleton under
// its own label: it is never a base and names none.
export function projectSkeleton(value, evidence, label) {
  const own = delivered(skeletonOf(value));
  if (!evidence || !Object.keys(own).length || value.preferences_complete === false) return value;
  const parts = { ...own, [SKELETON_LABEL]: label(value) };
  const names = [SKELETON_LABEL, ...SKELETON_FIELDS].filter(name => Object.hasOwn(parts, name));
  const from = {};
  for (const part of names) {
    const base = evidence.bases.findLast(item => Object.hasOwn(item.parts, part)
      && canonicalJson(item.parts[part]) === canonicalJson(parts[part]));
    if (base) (from[base.revision] ??= []).push(part);
  }
  const complete = withRevision(value, label);
  const revisions = Object.keys(from);
  if (!revisions.length) return complete;
  const left = new Set(Object.values(from).flat());
  const chain = [...new Map(evidence.bases.filter(item => Object.hasOwn(from, item.revision))
    .map(item => [item.revision, item.parts])).entries()];
  const resolved = Object.assign({}, ...chain.map(([, partsOf]) => partsOf));
  const exact = left.has(SKELETON_LABEL) && [...left].every(part => Object.hasOwn(resolved, part))
    && Object.entries(resolved).every(([part, item]) => Object.hasOwn(parts, part)
      && (!left.has(part) || canonicalJson(item) === canonicalJson(parts[part])));
  const named = !exact ? from : chain.length === 1 ? chain[0][0] : chain.map(([revision]) => revision);
  const trimmed = withRevision({ ...Object.fromEntries(Object.entries(value).filter(([key]) => !left.has(key))),
    skeleton_unchanged: named }, label);
  return frameBytes(trimmed, label) < frameBytes(complete, label) ? trimmed : complete;
}

function skeletonTokenHash(token) {
  return contentHash({ purpose: 'skeleton-task-token-v1', token });
}

function skeletonPromptHash(prompt) {
  return contentHash({ purpose: 'skeleton-task-prompt-v1', prompt });
}

function skeletonOwnerHash(value) {
  return contentHash({ purpose: 'skeleton-task-owner-v1', project: value.context?.personal_project_id ?? null,
    agent: value.context?.project_agent_id ?? null });
}

// The prompt, project and Agent each task delivered here was begun with, by
// hash only, newest last: [token, prompt, owner].
export function rememberSkeletonPrompt(prompts, value, prompt) {
  if (typeof prompt !== 'string' || typeof value.taskContextToken !== 'string') return prompts;
  const key = skeletonTokenHash(value.taskContextToken);
  if (prompts.some(([tokenHash]) => tokenHash === key)) return prompts;
  return [...prompts, [key, skeletonPromptHash(prompt), skeletonOwnerHash(value)]].slice(-MAX_SKELETON_PROMPTS);
}

export function validSkeletonPrompts(value) {
  return Array.isArray(value) && value.length <= MAX_SKELETON_PROMPTS
    && value.every(item => Array.isArray(item) && item.length === 3 && item.every(hash => HASH.test(hash)));
}

// A frame that still shows a skeleton field names it, with the label it
// shows in its own words, by revision.
function withRevision(frame, label) {
  return Object.keys(skeletonOf(frame)).length
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
  return contentHash({ purpose: 'task-entry-skeleton-v2', skeleton: delivered(skeletonOf(frame)), label }).slice(0, 12);
}

function skeletonOf(value) {
  return Object.fromEntries(SKELETON_FIELDS.filter(field => value?.[field] !== undefined).map(field => [field, value[field]]));
}

// The fields as the frame delivers them: JSON drops undefined.
function delivered(skeleton) {
  return JSON.parse(JSON.stringify(skeleton));
}

function frameBytes(frame, label) {
  return Buffer.byteLength(skeletonFrameLabel(label(frame), frame)) + Buffer.byteLength(JSON.stringify(frame));
}
