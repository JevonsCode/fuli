import { InvalidInputError } from '../app/application-error.js';
import { jsonFormat, readJsonRecord, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { singleLine } from '../text/single-line.js';
import { modelTier } from './model-tiers.js';

// 整理 (rec#114): Astro organises a project's knowledge. It fills what is
// missing from the project's files and history (with the person's consent,
// from their clients' memories and earlier sessions), merges what repeats,
// marks what is stale or contradicts, and tidies the rest. The first run on a
// project is its onboarding. There is no interview: what the Agent is unsure
// of goes to a short list the person may answer.
//
// This store keeps how well nine areas are covered, which sources were read,
// and what each run did, so a run can stop and go on in any client and the
// console can show 「已了解 7 / 9」 and the last report. It holds no
// knowledge: what a run adds or proposes is ordinary pending knowledge.

export const PROJECT_ORGANIZING_FORMAT = jsonFormat({ store: 'project-organizing', versions: [1] });

// The areas, most basic first.
export const ORGANIZING_AREAS = Object.freeze([
  { id: 'purpose', zh: '这个项目是什么、给谁用', en: 'What the project is and who it is for' },
  { id: 'stack', zh: '技术栈和目录结构', en: 'Stack and layout' },
  { id: 'run', zh: '怎么运行、测试、发布', en: 'How to run, test and release' },
  { id: 'conventions', zh: '约定和品味', en: 'Conventions and taste' },
  { id: 'decisions', zh: '重要决定和原因', en: 'Decisions and their reasons' },
  { id: 'pitfalls', zh: '踩过的坑', en: 'Pitfalls' },
  { id: 'people', zh: '人和分工', en: 'People and who does what' },
  { id: 'systems', zh: '外部系统在哪', en: 'Where the outside systems are' },
  { id: 'preferences', zh: '你的做事偏好', en: 'Your working preferences' }
]);
// known: enough is recorded. unsure: something was found that the person has
// not confirmed. missing: nothing found yet. not_applicable: the person said
// the project has none.
export const AREA_STATUSES = Object.freeze(['known', 'unsure', 'missing', 'not_applicable']);
// What a run may read. The last three hold more than the project's own files,
// so each needs the person's yes before it is read.
// named_material is what the person pointed at in their request: a folder of
// documents, files, links, or another knowledge base this client can open.
// Naming it is the consent.
export const ORGANIZING_SOURCES = Object.freeze(['project_files', 'history', 'named_material', 'client_memories', 'past_sessions', 'external']);
export const CONSENT_SOURCES = Object.freeze(['client_memories', 'past_sessions', 'external']);
export const SOURCE_STATUSES = Object.freeze(['read', 'declined', 'unavailable']);
// What one run did, as counts: added (new pending knowledge), merged
// (duplicates proposed as one), stale (marked out of date or contradicting),
// unsure (left for the person to answer).
export const RUN_COUNTS = Object.freeze(['added', 'merged', 'stale', 'unsure']);
const NOTE_CHARS = 200;
const SCOPE_CHARS = 120;
const MODEL_CHARS = 120;
const MAX_COUNT = 100_000;
const KEPT_RUNS = 10;
const AREA_IDS = new Set(ORGANIZING_AREAS.map(area => area.id));

export function createProjectOrganizing({ path, now = () => new Date() }) {
  const stored = () => readJsonRecord(path, PROJECT_ORGANIZING_FORMAT)?.projects ?? {};
  const key = (personalSpaceId, personalProjectId) => `${personalSpaceId}\n${personalProjectId}`;

  function view(personalSpaceId, personalProjectId) {
    return projectView(stored()[key(personalSpaceId, personalProjectId)] ?? null);
  }

  // Merges the areas and sources named, and adds the run's report when one is
  // given; everything else stays as it was.
  function update(personalSpaceId, personalProjectId, { areas = {}, sources = {}, run = null } = {}) {
    const areaChanges = Object.entries(areas ?? {}).map(([id, value]) => [id, areaState(id, value)]);
    const sourceChanges = Object.entries(sources ?? {}).map(([id, value]) => [id, sourceState(id, value)]);
    const at = now().toISOString();
    const report = run ? runReport(run, at) : null;
    if (!areaChanges.length && !sourceChanges.length && !report) throw new InvalidInputError('Send areas, sources, run or several');
    const saved = updateVersionedJsonFileAtomic(path, PROJECT_ORGANIZING_FORMAT, (record) => {
      const projects = { ...(record?.projects ?? {}) };
      const id = key(personalSpaceId, personalProjectId);
      const project = projects[id] ?? { startedAt: at, areas: {}, sources: {}, runs: [] };
      projects[id] = { ...project, updatedAt: at,
        areas: { ...project.areas, ...Object.fromEntries(areaChanges) },
        sources: { ...project.sources, ...Object.fromEntries(sourceChanges) },
        runs: report ? [report, ...(project.runs ?? [])].slice(0, KEPT_RUNS) : project.runs ?? [] };
      return { version: 1, projects };
    }, { read: () => readJsonRecord(path, PROJECT_ORGANIZING_FORMAT) });
    return projectView(saved.projects[key(personalSpaceId, personalProjectId)]);
  }

  // Whether any project was ever organised here; a missing file reads as none.
  const started = () => Object.keys(stored()).length > 0;

  return Object.freeze({ view, update, started });
}

function areaState(id, value) {
  if (!AREA_IDS.has(id)) throw new InvalidInputError(`Unknown area: ${id}`);
  if (!AREA_STATUSES.includes(value?.status)) throw new InvalidInputError(`areas.${id}.status is one of ${AREA_STATUSES.join(', ')}`);
  if (value.note !== undefined && typeof value.note !== 'string') throw new InvalidInputError(`areas.${id}.note is plain text`);
  const note = singleLine(value.note ?? '').slice(0, NOTE_CHARS);
  return { status: value.status, ...(note ? { note } : {}) };
}

function sourceState(id, value) {
  if (!ORGANIZING_SOURCES.includes(id)) throw new InvalidInputError(`Unknown source: ${id}`);
  if (!SOURCE_STATUSES.includes(value)) throw new InvalidInputError(`sources.${id} is one of ${SOURCE_STATUSES.join(', ')}`);
  return value;
}

// One run as it is kept: when, on which model and its tier, what it covered, and its counts.
function runReport(run, at) {
  if (typeof run !== 'object' || Array.isArray(run)) throw new InvalidInputError('run is an object');
  const counts = Object.fromEntries(RUN_COUNTS.map((name) => {
    const value = run[name] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new InvalidInputError(`run.${name} is a whole number`);
    return [name, value];
  }));
  for (const name of ['model', 'scope']) {
    if (run[name] !== undefined && typeof run[name] !== 'string') throw new InvalidInputError(`run.${name} is plain text`);
  }
  const model = singleLine(run.model ?? '').slice(0, MODEL_CHARS);
  const scope = singleLine(run.scope ?? '').slice(0, SCOPE_CHARS);
  return { at, model: model || null, tier: modelTier(model), ...(scope ? { scope } : {}), ...counts };
}

// A project as the console and an Agent read it: every area with its state
// (missing until something is recorded), how much is settled, what is open,
// and what the runs did, newest first.
function projectView(project) {
  const areas = ORGANIZING_AREAS.map(area => ({ id: area.id, zh: area.zh, en: area.en,
    status: project?.areas?.[area.id]?.status ?? 'missing',
    ...(project?.areas?.[area.id]?.note ? { note: project.areas[area.id].note } : {}) }));
  const settled = areas.filter(area => area.status === 'known' || area.status === 'not_applicable').length;
  return { started: Boolean(project), startedAt: project?.startedAt ?? null, updatedAt: project?.updatedAt ?? null,
    areas, sources: { ...(project?.sources ?? {}) },
    progress: { settled, total: areas.length, complete: settled === areas.length },
    open: [...areas.filter(area => area.status === 'unsure'), ...areas.filter(area => area.status === 'missing')].map(area => area.id),
    runs: [...(project?.runs ?? [])] };
}
