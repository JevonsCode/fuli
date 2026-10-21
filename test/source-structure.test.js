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
// The session layer (rec#5 C3, C3b) is part of the settings: its pause and
// switch records are read only by the port and its session layer too.
const CAPTURE_SETTINGS_OWNERS = new Set([CAPTURE_PORT, 'src/graphiti/capture-policy.js', 'src/graphiti/capture-session-pause.js',
  'src/graphiti/session-layer-decision.js']);
const CAPTURE_SETTINGS_ACCESS = /getCapturePolicy|capturePolicyStore|CapturePolicyStore|\bpolicyStore\b|capture-policy\.js|getSessionCapturePause|hasSessionWithoutCapture|hasStoppedSession|sessionFuliDefault\(|SessionCapturePauseStore|sessionCapturePauseStore|capture-session-pause\.js/;
const CAPTURE_SETTINGS_CALL_SITES = new Map([
  // rec#17: the data format inventory reads only the file's format version, never a setting.
  ['src/data-format/local-stores.js', ["['capture-policy.json', CAPTURE_POLICY_FORMAT],",
    "import { CAPTURE_POLICY_FORMAT } from '../graphiti/capture-policy.js';",
    "import { CAPTURE_SESSION_PAUSE_FORMAT } from '../graphiti/capture-session-pause.js';"]],
  ['src/http/graph-api-router.js', ['sendJson(response, 200, app.getCapturePolicy());']],
  ['src/conversations/capture-window.js', ['getCapturePolicy: application.getCapturePolicy?.bind(application),',
    'getCapturePolicyVersion: application.getCapturePolicyVersion?.bind(application),',
    'getSessionCapturePause: application.getSessionCapturePause?.bind(application),',
    'hasSessionWithoutCapture: application.hasSessionWithoutCapture?.bind(application), personal: {']],
  // rec#5 C10: setup wires a new installation's question to the settings it saves into.
  ['src/setup/first-run-capture.js', ["import { CapturePolicyStore, capturePolicyPathForRuntime } from '../graphiti/capture-policy.js';",
    'return createCaptureOnboarding(capturePolicyStoreFor(paths));', 'const store = capturePolicyStoreFor(paths);',
    'function capturePolicyStoreFor(paths) {', 'return new CapturePolicyStore(capturePolicyPathForRuntime(paths.graphRuntimeConfigPath));']],
  // The worker host only links a worker's session to the session that started it.
  ['src/server/worker-plan-runtime.js', [
    "import { SessionCapturePauseStore, sessionCapturePausePathForRuntime } from '../graphiti/capture-session-pause.js';",
    'const sessionPauses = new SessionCapturePauseStore(sessionCapturePausePathForRuntime(runtimeConfigPath));']],
  ['src/graphiti/federated-application.js', [
    'CapturePolicyStore,', "} from './capture-policy.js';", 'capturePolicyStore,',
    'const policyStore = capturePolicyStore ?? new CapturePolicyStore(', 'capturePolicyStore: policyStore,',
    'capturePolicy: app.getCapturePolicy(), consoleUrl: app.consoleUrl });', 'capturePolicyStore = new CapturePolicyStore(),',
    'this.capturePolicyStore = capturePolicyStore;',
    'this.captureChanges = createCaptureChanges(capturePolicyStore, captureChangeReads);',
    'this.captureOnboarding = createCaptureOnboarding(capturePolicyStore);', 'getCapturePolicy() {', 'return this.capturePolicyStore.read();',
    'getCapturePolicyVersion() {', 'return this.capturePolicyStore.version();',
    'advanceCapturePolicyVersion() {', 'return this.capturePolicyStore.advanceVersion();',
    'return this.capturePolicyStore.update(input);', 'capturePolicy: this.getCapturePolicy(),',
    "import { SessionCapturePauseStore, sessionCapturePausePathForRuntime } from './capture-session-pause.js';",
    'sessionCapturePauseStore: new SessionCapturePauseStore(sessionCapturePausePathForRuntime(runtimeConfigPath)),',
    'sessionCapturePauseStore = new SessionCapturePauseStore(),', 'this.sessionCapturePauseStore = sessionCapturePauseStore;',
    'getSessionCapturePause(sessionId) {', 'return this.sessionCapturePauseStore.state(sessionId);',
    'hasSessionWithoutCapture(sourceApplication) {', 'return this.sessionCapturePauseStore.anyWithoutCapture(sourceApplication);',
    'hasStoppedSession(sourceApplication = null) {', 'return this.sessionCapturePauseStore.anyStopped(sourceApplication);',
    'return this.sessionCapturePauseStore.set(sessionId, change);',
    'return this.sessionCapturePauseStore.setEnabled(sessionId, change);', 'sessionFuliDefault() {',
    'return this.sessionCapturePauseStore.defaultSetting();', 'return this.sessionCapturePauseStore.setDefault(enabled);',
    'return this.sessionCapturePauseStore.pinDefault(sessionId, sourceApplication, start);'
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
    ['src/graphiti/federated-application.js', 'const settings = policyStore.read();'],
    ['src/example.js', 'if (app.getSessionCapturePause(sessionId).paused) return;']
  ]) assert.equal(captureDecisionsOutsidePort(path, bypass).length, 1, `${path}: ${bypass}`);
});

// rec#18 D-10: one agent adapter port, two implementations. Only the registry
// knows whether a client is descriptor-backed or code-backed, so no caller can
// branch on which ids are still legacy.
const AGENT_REGISTRY = 'src/setup/agents/registry.js';
const AGENT_IMPLEMENTATION_IMPORT = /from '[^']*(?:descriptor-adapter|descriptor-packs|(?:agents\/|\.\/)[a-z-]+\/index)\.js'/;

function agentImplementationImports(path, source) {
  if (path === AGENT_REGISTRY || path.endsWith('.test.js')) return [];
  return source.split(/\r?\n/).flatMap((line, index) =>
    AGENT_IMPLEMENTATION_IMPORT.test(line) && (path.startsWith('src/setup/') || /setup\/agents\//.test(line))
      ? [`- ${path}:${index + 1}: ${line.trim()}`] : []);
}

test('agent adapters are reached only through the registry port', () => {
  const offenders = sourceFiles('src').filter(path => extname(path) === '.js')
    .flatMap(path => agentImplementationImports(path.split('\\').join('/'), readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, [], `Use agentAdapter(id) from ${AGENT_REGISTRY}:\n${offenders.join('\n')}`);
  for (const [path, bypass] of [
    ['src/setup/agents.js', "import { adapter } from './agents/gemini/index.js';"],
    ['src/system/client-connection-status.js', "import { descriptorAdapter } from '../setup/agents/descriptor-adapter.js';"],
    ['src/setup/setup.js', "import { loadClientDescriptorPacks } from './agents/descriptor-packs.js';"]
  ]) assert.equal(agentImplementationImports(path, bypass).length, 1, `${path}: ${bypass}`);
});
