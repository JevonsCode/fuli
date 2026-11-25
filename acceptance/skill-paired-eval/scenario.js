// A small declarative scenario for one paired evaluation: a text-only project,
// a matched task and an unrelated control task, the acceptance checks, and an
// optional deterministic stand-in. It is data only: no commands, callbacks or
// paths outside the temporary workspace. Everything is validated before the
// runner creates a workspace or an output directory.
import { statSync, readFileSync } from 'node:fs';

import { FIXTURE_PROJECT_FILES, FIXTURE_TASKS } from './fixture.js';

const LIMITS = Object.freeze({
  scenarioBytes: 256 * 1024,
  files: 20,
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  name: 120,
  id: 100,
  prompt: 8000,
  checks: 20,
  allowed: 20,
  forbiddenFiles: 10,
  markers: 20,
  markerBytes: 200,
  path: 200
});

const CONTROLS = new Set(['TASK.md', 'AGENTS.md', 'opencode.json', '.opencode', '.git']);
const CHECK_TYPES = new Set(['file-equals', 'file-unchanged', 'only-changed', 'output-excludes']);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RUN_NAME_LIMIT = 64;

function fail(label, detail) {
  throw new TypeError(`Invalid scenario ${label}: ${detail}`);
}

// Control files are compared case-insensitively on Windows, where task.md and
// TASK.md are the same file. Elsewhere the exact name is kept.
function isControlPath(value, platform) {
  const fold = platform === 'win32' ? item => item.toLowerCase() : item => item;
  const controls = platform === 'win32' ? new Set([...CONTROLS].map(name => name.toLowerCase())) : CONTROLS;
  const first = value.split('/')[0];
  return controls.has(fold(first)) || controls.has(fold(value));
}

// One portable directory basename for a run: no separators, no `.`/`..`, no
// drive letter, no trailing dot, no Windows device name. A retry must pick a
// new name so it can never replace an earlier report.
export function safeRunDirectoryName(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Invalid --pair-id: it must be one directory name');
  if (value.length > RUN_NAME_LIMIT) throw new TypeError(`Invalid --pair-id: it is longer than ${RUN_NAME_LIMIT} characters`);
  if (!RUN_NAME.test(value)) {
    throw new TypeError('Invalid --pair-id: use one portable directory name (letters, digits, ".", "_" or "-", '
      + 'starting with a letter or digit), not a path');
  }
  if (value.endsWith('.')) throw new TypeError('Invalid --pair-id: it must not end with "."');
  if (WINDOWS_RESERVED.test(value)) throw new TypeError(`Invalid --pair-id: "${value}" is a reserved Windows device name`);
  return value;
}

function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) fail(label, 'needs non-empty text');
  if (value.length > maximum) fail(label, `is longer than ${maximum} characters`);
  return value;
}

// A basename or a path inside the workspace. Backslashes, drive letters,
// absolute paths, `.`/`..` segments and control files are refused so a scenario
// cannot name a path the runner would write outside its own temporary project.
export function safeRelativePath(value, label = 'path', { platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value) fail(label, 'needs a relative path');
  if (value.length > LIMITS.path) fail(label, `is longer than ${LIMITS.path} characters`);
  if (/[\u0000-\u001f\u007f\\:]/u.test(value)) fail(label, 'contains a control character, backslash or drive separator');
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) fail(label, 'must be relative to the workspace');
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    fail(label, 'must not contain empty, "." or ".." segments');
  }
  if (segments.some(segment => !/^[A-Za-z0-9._][A-Za-z0-9._ -]*$/u.test(segment)
    || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED.test(segment))) {
    fail(label, 'contains a segment that is not a plain portable file name');
  }
  if (segments.some(segment => ['__proto__', 'constructor', 'prototype'].includes(segment))) {
    fail(label, 'contains a reserved object key');
  }
  if (isControlPath(value, platform)) fail(label, `must not name ${value}`);
  return segments.join('/');
}

function fileMap(value, label, options) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'must be a JSON object of path to text');
  const entries = Object.entries(value);
  if (entries.length > LIMITS.files) fail(label, `lists more than ${LIMITS.files} files`);
  let total = 0;
  const files = {};
  for (const [path, content] of entries) {
    const safe = safeRelativePath(path, `${label}.${path}`, options);
    if (typeof content !== 'string') fail(`${label}.${safe}`, 'must be text');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LIMITS.fileBytes) fail(`${label}.${safe}`, `is larger than ${LIMITS.fileBytes} bytes`);
    total += bytes;
    if (total > LIMITS.totalBytes) fail(label, `is larger than ${LIMITS.totalBytes} bytes`);
    files[safe] = content;
  }
  return files;
}

function pathList(value, label, maximum = LIMITS.allowed, options) {
  if (!Array.isArray(value) || value.length > maximum) fail(label, `must list at most ${maximum} paths`);
  return value.map((path, index) => safeRelativePath(path, `${label}[${index}]`, options));
}

function stringList(value, label, maximum = LIMITS.markers) {
  if (!Array.isArray(value) || value.length > maximum) fail(label, `must list at most ${maximum} texts`);
  return value.map((item, index) => text(item, `${label}[${index}]`, LIMITS.markerBytes));
}

function check(value, index, options) {
  const label = `check[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'must be an object');
  if (!CHECK_TYPES.has(value.type)) fail(`${label}.type`, `must be one of ${[...CHECK_TYPES].join(', ')}`);
  if (value.type === 'file-equals') {
    return { type: value.type, path: safeRelativePath(value.path, `${label}.path`, options), value: text(value.value, `${label}.value`, LIMITS.fileBytes) };
  }
  if (value.type === 'file-unchanged') return { type: value.type, path: safeRelativePath(value.path, `${label}.path`, options) };
  if (value.type === 'only-changed') return { type: value.type, allowed: pathList(value.allowed, `${label}.allowed`, LIMITS.allowed, options) };
  return { type: value.type, values: stringList(value.values, `${label}.values`) };
}

function standIn(value, kind, options) {
  const label = 'standIn';
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'must be an object');
  if (kind === 'positive') {
    const off = fileMap(value.offFiles, `${label}.offFiles`, options);
    const on = fileMap(value.onFiles, `${label}.onFiles`, options);
    if (!Object.keys(off).length || !Object.keys(on).length) fail(label, 'needs offFiles and onFiles');
    return { offFiles: off, onFiles: on };
  }
  const files = fileMap(value.files, `${label}.files`, options);
  if (!Object.keys(files).length) fail(label, 'needs files');
  return { files };
}

function task(value, kind, options) {
  const label = kind;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'must be an object');
  const extra = Object.keys(value).filter(key => !['id', 'kind', 'prompt', 'checks', 'forbidden', 'standIn'].includes(key));
  if (extra.length) fail(label, `has unsupported fields: ${extra.join(', ')}`);
  if (value.kind !== undefined && value.kind !== kind) fail(`${label}.kind`, `must be ${kind}`);
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > LIMITS.checks) {
    fail(`${label}.checks`, `must list 1 to ${LIMITS.checks} checks`);
  }
  const normalized = {
    id: text(value.id, `${label}.id`, LIMITS.id),
    kind,
    prompt: text(value.prompt, `${label}.prompt`, LIMITS.prompt),
    checks: value.checks.map((item, index) => check(item, index, options))
  };
  if (kind === 'negative' && value.forbidden !== undefined) {
    const forbidden = value.forbidden;
    if (!forbidden || typeof forbidden !== 'object' || Array.isArray(forbidden)) fail(`${label}.forbidden`, 'must be an object');
    normalized.forbidden = {
      files: forbidden.files === undefined ? [] : pathList(forbidden.files, `${label}.forbidden.files`, LIMITS.forbiddenFiles, options),
      markers: forbidden.markers === undefined ? [] : stringList(forbidden.markers, `${label}.forbidden.markers`)
    };
  }
  if (kind === 'positive' && value.forbidden !== undefined) fail(`${label}.forbidden`, 'is only allowed on the negative control');
  if (value.standIn !== undefined) normalized.standIn = standIn(value.standIn, kind, options);
  return normalized;
}

// The normalized scenario a runner may use. Unknown fields are refused on
// purpose: no executable hook can hide in a name the runner ignores. `platform`
// lets a test check the Windows case-insensitive control-name rule anywhere.
export function validateScenario(value, options = {}) {
  const { platform = process.platform } = options;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('root', 'must be a JSON object');
  const extra = Object.keys(value).filter(key => !['name', 'files', 'positive', 'negative'].includes(key));
  if (extra.length) fail('root', `has unsupported fields: ${extra.join(', ')}`);
  return {
    ...(value.name === undefined ? {} : { name: text(value.name, 'name', LIMITS.name) }),
    files: fileMap(value.files, 'files', { platform }),
    positive: task(value.positive, 'positive', { platform }),
    negative: task(value.negative, 'negative', { platform })
  };
}

export function loadScenario(path) {
  let stat;
  try { stat = statSync(path); } catch (error) { throw new TypeError(`Cannot read scenario ${path}: ${error.message}`); }
  if (!stat.isFile()) throw new TypeError(`Scenario ${path} is not a regular file`);
  if (stat.size > LIMITS.scenarioBytes) throw new TypeError(`Scenario ${path} is larger than ${LIMITS.scenarioBytes} bytes`);
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new TypeError(`Scenario ${path} is not valid JSON: ${error.message}`); }
  return validateScenario(parsed);
}

// The built-in fixture is the default scenario, so the CLI still works without
// --scenario. Its stand-in is data, not code: the deterministic seam writes it.
export const DEFAULT_SCENARIO = validateScenario({
  name: 'Release tag convention',
  files: FIXTURE_PROJECT_FILES,
  positive: FIXTURE_TASKS.positive,
  negative: FIXTURE_TASKS.negative
});
