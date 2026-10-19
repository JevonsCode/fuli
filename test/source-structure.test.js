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

// rec#5 C1-3: one capture port decides every write. Only the port and the store
// itself may read the stored capture settings; the call sites listed here only
// hand them on unchanged (settings display, MCP, console state, the capture
// window forwarding the reader) or wire the store. Any other line that touches
// the settings or their store, in any file, fails until it asks the port.
const CAPTURE_PORT = 'src/graphiti/capture-decision.js';
const CAPTURE_SETTINGS_OWNERS = new Set([CAPTURE_PORT, 'src/graphiti/capture-policy.js']);
const CAPTURE_SETTINGS_ACCESS = /getCapturePolicy|capturePolicyStore|CapturePolicyStore|\bpolicyStore\b|capture-policy\.js/;
const CAPTURE_SETTINGS_CALL_SITES = new Map([
  ['src/agent-tools/graph-handlers.js', ['get_capture_policy: (app) => app.getCapturePolicy(),']],
  ['src/http/graph-api-router.js', ['sendJson(response, 200, app.getCapturePolicy());']],
  ['src/conversations/capture-window.js', ['getCapturePolicy: application.getCapturePolicy?.bind(application), personal: {']],
  ['src/graphiti/federated-application.js', [
    'CapturePolicyStore,', "} from './capture-policy.js';", 'capturePolicyStore,',
    'const policyStore = capturePolicyStore ?? new CapturePolicyStore(', 'capturePolicyStore: policyStore,',
    'capturePolicy: app.getCapturePolicy(), consoleUrl: app.consoleUrl });', 'capturePolicyStore = new CapturePolicyStore(),',
    'this.capturePolicyStore = capturePolicyStore;', 'getCapturePolicy() {', 'return this.capturePolicyStore.read();',
    'return this.capturePolicyStore.update(input);', 'capturePolicy: this.getCapturePolicy(),'
  ]]
]);

function captureDecisionsOutsidePort(path, source) {
  if (CAPTURE_SETTINGS_OWNERS.has(path)) return [];
  const allowed = CAPTURE_SETTINGS_CALL_SITES.get(path) ?? [];
  return source.split(/\r?\n/).flatMap((line, index) =>
    CAPTURE_SETTINGS_ACCESS.test(line) && !allowed.includes(line.trim()) ? [`- ${path}:${index + 1}: ${line.trim()}`] : []);
}

test('capture writes are decided only by the capture port', () => {
  const offenders = sourceFiles('src').filter(path => extname(path) === '.js')
    .flatMap(path => captureDecisionsOutsidePort(path.split('\\').join('/'), readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, [], `Ask captureDecision() from ${CAPTURE_PORT}, or list a settings display call site:\n${offenders.join('\n')}`);
  // The check must keep recognising the bypasses it exists for, including a
  // helper that decides from the settings and a reader in a file not listed.
  for (const [path, bypass] of [
    ['src/example.js', "if (!app.getCapturePolicy?.('codex').enabled) return;"],
    ['src/example.js', 'if (allowsCapture(app.getCapturePolicy())) write();'],
    ['src/example.js', 'sendJson(response, 200, app.getCapturePolicy());'],
    ['src/example.js', 'return this.capturePolicyStore.read();'],
    ['src/example.js', "import { CapturePolicyStore } from './capture-policy.js';"],
    ['src/graphiti/federated-application.js', 'if (allowsCapture(this.getCapturePolicy())) write();'],
    ['src/graphiti/federated-application.js', 'const settings = policyStore.read();']
  ]) assert.equal(captureDecisionsOutsidePort(path, bypass).length, 1, `${path}: ${bypass}`);
});
