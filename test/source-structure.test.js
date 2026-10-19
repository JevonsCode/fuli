import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';

const SOURCE_ROOTS = [
  'src',
  'web',
  'graph-provider/fuli_graph',
  'graph-provider/tests',
  'test'
];
const SOURCE_EXTENSIONS = new Set(['.js', '.ts', '.vue', '.py', '.css', '.html']);
const HARD_LINE_LIMIT = 1300;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === '__pycache__') return [];
      return sourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function lineCount(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).length;
}

test('source files stay below the hard size limit', () => {
  const offenders = SOURCE_ROOTS.flatMap(sourceFiles)
    .map((path) => ({ path, lines: lineCount(path) }))
    .filter(({ lines }) => lines > HARD_LINE_LIMIT);

  assert.deepEqual(
    offenders,
    [],
    `Split oversized files before adding more responsibilities:\n${offenders
      .map(({ path, lines }) => `- ${path}: ${lines} lines`)
      .join('\n')}`
  );
});

test('the Vue browser entry remains an orchestration layer', () => {
  assert.ok(
    lineCount('web/src/main.ts') <= 100,
    'web/src/main.ts should only initialize Vue and application plugins'
  );
});

// rec#5 C1: one capture port decides every write. Settings surfaces may hand the
// stored capture settings on whole (HTTP, MCP, console state) or forward the
// reader (capture window); a call that names a client, inspects the result,
// falls back to a default or keeps it for later decides a write outside the port.
const CAPTURE_PORT = join('src', 'graphiti', 'capture-decision.js');
const CAPTURE_SETTINGS_HANDOFF = /^getCapturePolicy(?:\(\)\s*(?=[,)}]|$)|\??\.bind\(|\s*:)/;

function captureDecisionsOutsidePort(path, source) {
  if (path === CAPTURE_PORT) return [];
  return source.split(/\r?\n/).flatMap((line, index) => {
    const offending = [...line.matchAll(/getCapturePolicy/g)].some(({ index: at }) => {
      if (/^\s*getCapturePolicy\(\)\s*\{\s*$/.test(line)) return false;
      if (/(?:const|let|var)\s+[\w$]+\s*=\s*[\w$.?]*$/.test(line.slice(0, at))) return true;
      return !CAPTURE_SETTINGS_HANDOFF.test(line.slice(at));
    }) || (line.includes('capturePolicyStore.read(') && line.trim() !== 'return this.capturePolicyStore.read();');
    return offending ? [`- ${path}:${index + 1}: ${line.trim()}`] : [];
  });
}

test('capture writes are decided only by the capture port', () => {
  const offenders = sourceFiles('src').filter(path => extname(path) === '.js')
    .flatMap(path => captureDecisionsOutsidePort(path, readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, [], `Ask captureDecision() from ${CAPTURE_PORT} instead:\n${offenders.join('\n')}`);
  // The check must keep recognising the bypasses it exists for.
  for (const bypass of [
    "if (!app.getCapturePolicy?.('codex').enabled) return;",
    'const policy = this.getCapturePolicy(sourceApplication);',
    'const policy = app.getCapturePolicy();',
    'const policy = app.getCapturePolicy?.() ?? { enabled: true };',
    'if (this.capturePolicyStore.read().enabled) write();'
  ]) assert.equal(captureDecisionsOutsidePort('src/example.js', bypass).length, 1, bypass);
});
