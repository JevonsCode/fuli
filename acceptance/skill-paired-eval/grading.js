// Common acceptance rules for one paired evaluation. They read the files and
// output a client actually produced after the task; nothing here knows what
// the answer should have been from the selected workflow. A deterministic
// stand-in and a live client go through the same rules. Only regular local files
// are read: symbolic links and other non-regular entries are skipped, and the
// stored evidence is capped per file and in total.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_FILES = 100;
const CONTROL_PATHS = new Set(['TASK.md', 'AGENTS.md', 'opencode.json']);

function normalizeText(value) {
  return String(value ?? '').replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '').trimEnd();
}

function isControlPath(path) {
  const first = path.split('/')[0];
  return CONTROL_PATHS.has(path) || first === '.opencode' || first === '.git';
}

function walk(directory, relative, skipped) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (isControlPath(path)) return [];
    if (entry.isSymbolicLink()) { skipped.push({ path, reason: 'symbolic link' }); return []; }
    if (entry.isDirectory()) return walk(`${directory}/${entry.name}`, path, skipped);
    if (!entry.isFile()) { skipped.push({ path, reason: 'not a regular file' }); return []; }
    return [{ path, absolute: `${directory}/${entry.name}` }];
  });
}

// The workspace as evidence: regular text files only, with skipped entries
// named rather than silently cut. The baseline is the scenario the client
// started from.
export function observeWorkspace({ directory, baseline = {}, stdout = '', stderr = '', exitCode = null,
  timedOut = false, corrections = null, correctionsUnavailable = null } = {}) {
  const files = {};
  const skipped = [];
  let total = 0;
  for (const { path, absolute } of walk(directory, '', skipped)) {
    if (Object.keys(files).length >= MAX_FILES) { skipped.push({ path, reason: `more than ${MAX_FILES} files` }); continue; }
    const stat = lstatSync(absolute);
    if (!stat.isFile()) { skipped.push({ path, reason: 'not a regular file' }); continue; }
    if (stat.size > MAX_FILE_BYTES) { skipped.push({ path, reason: `larger than ${MAX_FILE_BYTES} bytes` }); continue; }
    if (total + stat.size > MAX_TOTAL_BYTES) { skipped.push({ path, reason: `over the ${MAX_TOTAL_BYTES}-byte total` }); continue; }
    let text;
    try { text = readFileSync(absolute, 'utf8'); } catch { skipped.push({ path, reason: 'unreadable' }); continue; }
    total += Buffer.byteLength(text, 'utf8');
    files[path] = { text, bytes: Buffer.byteLength(text, 'utf8') };
  }
  const changedPaths = new Set();
  for (const path of new Set([...Object.keys(baseline), ...Object.keys(files)])) {
    const before = baseline[path] === undefined ? null : normalizeText(baseline[path]);
    const after = files[path]?.text === undefined ? null : normalizeText(files[path].text);
    if (before !== after) changedPaths.add(path);
  }
  return {
    files,
    skipped,
    baseline,
    stdout,
    stderr,
    exitCode,
    timedOut,
    corrections,
    correctionsUnavailable,
    changedPaths: [...changedPaths].sort(),
    newFiles: Object.keys(files).filter(path => baseline[path] === undefined).sort()
  };
}

function check(type, path, pass, expected, actual) {
  return { type, path, pass, expected, actual };
}

function evaluateCheck(rule, observation) {
  const current = observation.files[rule.path]?.text;
  if (rule.type === 'file-equals') {
    return check(rule.type, rule.path, current !== undefined && normalizeText(current) === normalizeText(rule.value),
      normalizeText(rule.value), current === undefined ? null : normalizeText(current));
  }
  if (rule.type === 'file-unchanged') {
    const before = observation.baseline[rule.path];
    const same = before === undefined ? current === undefined : current !== undefined && normalizeText(current) === normalizeText(before);
    return check(rule.type, rule.path, same, before === undefined ? 'unchanged' : normalizeText(before),
      current === undefined ? null : normalizeText(current));
  }
  if (rule.type === 'only-changed') {
    const allowed = new Set(rule.allowed ?? []);
    const extra = observation.changedPaths.filter(path => !allowed.has(path));
    return { type: rule.type, pass: extra.length === 0, expected: [...allowed].sort(), actual: observation.changedPaths, extra };
  }
  if (rule.type === 'output-excludes') {
    const markers = rule.values ?? [];
    const seen = markers.filter(marker => `${observation.stdout}\n${observation.stderr}`.includes(marker));
    return { type: rule.type, pass: seen.length === 0, expected: `none of ${markers.join(', ')}`, actual: seen };
  }
  throw new TypeError(`Unknown acceptance rule ${rule.type}`);
}

export function gradeTask(task, observation) {
  const completion = {
    type: 'client-completed',
    pass: observation.exitCode === 0 && !observation.timedOut,
    expected: 'exit code 0 and no timeout',
    actual: { exitCode: observation.exitCode, timedOut: observation.timedOut }
  };
  const checks = [completion, ...task.checks.map(rule => evaluateCheck(rule, observation))];
  return {
    pass: checks.every(item => item.pass),
    checks,
    corrections: Number.isInteger(observation.corrections)
      ? { count: observation.corrections, unavailable: null }
      : { count: null, unavailable: observation.correctionsUnavailable
        ?? 'The client did not expose turn or correction events, so corrections are unknown.' }
  };
}

// A negative control is the same one selected workflow applied to an unrelated
// task. It is measured only from what the client actually did: a forbidden
// file changed or a workflow-specific marker in the output or a changed file.
// Whether the Skill was read is kept beside the output effect, not folded into
// it: a read that does not change the answer is still worth seeing separately.
export function measureNegativeControl(task, observation, { skillRead = null } = {}) {
  const forbiddenFiles = (task.forbidden?.files ?? []).filter(path => observation.changedPaths.includes(path));
  const changedText = Object.entries(observation.files)
    .filter(([path]) => observation.changedPaths.includes(path))
    .map(([, file]) => file.text)
    .join('\n');
  const haystack = `${observation.stdout}\n${observation.stderr}\n${changedText}`;
  const markers = (task.forbidden?.markers ?? []).filter(marker => haystack.includes(marker));
  const triggeredBy = { files: forbiddenFiles, markers };
  const grading = gradeTask(task, observation);
  return {
    measured: true,
    skillRead,
    triggered: forbiddenFiles.length > 0 || markers.length > 0,
    triggeredBy,
    outputEffect: {
      changedPaths: observation.changedPaths,
      newFiles: observation.newFiles,
      markers
    },
    pass: forbiddenFiles.length === 0 && markers.length === 0 && grading.pass,
    checks: grading.checks,
    corrections: grading.corrections
  };
}
