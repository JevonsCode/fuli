import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { diffEmbeddingModels, embeddingModelBytes, parseEmbeddingModelsManifest } from '../src/embedding-models/manifest.js';
import { createEmbeddingModels } from '../src/embedding-models/port.js';
import { createEmbeddingModelStore, MODEL_SPEC_FILE } from '../src/embedding-models/store.js';
import { handleEmbeddingModelsRequest } from '../src/http/embedding-models-api-router.js';
import { readModelBackendConfig } from '../src/model-backends/config.js';
import { createModelBackendPort } from '../src/model-backends/port.js';
import { createModelRoleSettings } from '../src/model-backends/role-settings.js';
import { ModelUsageLedger } from '../src/model-backends/usage-ledger.js';

// Built-in embedding models: the catalog, the download with its digest check,
// and search using one. Every file is synthetic bytes from a fake transport;
// no real model is downloaded or run.

const REVISION = 'a'.repeat(40);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const CONTENT = { 'config.json': Buffer.from('{"synthetic":true}'), 'vocab.txt': Buffer.from('[PAD]\n[UNK]\n'),
  'model.safetensors': Buffer.alloc(4096, 7) };

function model(id = 'tiny-zh', overrides = {}) {
  return { id, name: 'Tiny synthetic', license: 'MIT', languages: ['zh'], dimensions: 16, maxTokens: 24, pooling: 'cls',
    lowercase: true, stripAccents: false, recommended: true, memoryMb: 10, summary: { zh: '合成模型。', en: 'Synthetic model.' },
    source: 'https://huggingface.co/synthetic/tiny', revision: REVISION,
    files: Object.entries(CONTENT).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes),
      urls: [`https://huggingface.co/synthetic/tiny/resolve/${REVISION}/${path}`, `https://hf-mirror.com/synthetic/tiny/resolve/${REVISION}/${path}`] })),
    ...overrides };
}

const manifest = (models = [model()], manifestVersion = 1) => ({ format: 'fuli-embedding-models', formatVersion: 1, manifestVersion,
  updatedAt: '2026-11-11', models });

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-embedding-models-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Serves CONTENT; `tamper(url)` may answer other bytes or a status for one address.
function transport(tamper = () => null) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const changed = tamper(url);
    if (typeof changed === 'number') return new Response(null, { status: changed });
    return new Response(changed ?? CONTENT[url.split(`/${REVISION}/`)[1]]);
  };
  return { fetchImpl, calls };
}

test('the catalog FULI ships parses, with one recommended model and files pinned to a commit', () => {
  const bundled = parseEmbeddingModelsManifest(JSON.parse(readFileSync(new URL('../registry/embedding-models.json', import.meta.url), 'utf8')));
  assert.equal(bundled.models.filter(item => item.recommended).length, 1);
  for (const item of bundled.models) {
    assert.deepEqual(item.files.map(file => file.path).sort(), ['config.json', 'model.safetensors', 'vocab.txt']);
    assert.ok(item.files.every(file => file.urls.every(url => url.includes(`/resolve/${item.revision}/`))));
    assert.ok(embeddingModelBytes(item) < 200 * 1024 * 1024, `${item.id} stays a small download`);
    assert.ok(item.summary.zh.length <= 100);
  }
});

test('a catalog copy is refused whole when it names anything FULI does not run or trust', () => {
  const refused = (change, pattern) => assert.throws(() => parseEmbeddingModelsManifest(manifest([change(structuredClone(model()))])), pattern);
  refused(item => { item.files[0].urls = ['https://example.com/x/resolve/' + REVISION + '/config.json']; return item; }, /huggingface\.co or hf-mirror\.com/);
  refused(item => { item.files[0].urls = ['http://huggingface.co/x/resolve/' + REVISION + '/config.json']; return item; }, /https URL/);
  refused(item => { item.files[0].urls = ['https://huggingface.co/x/resolve/main/config.json']; return item; }, /name the model's revision/);
  refused(item => { item.files[2].path = 'model.onnx'; return item; }, /path must be one of/);
  refused(item => { item.files[1] = item.files[0]; return item; }, /repeats a file/);
  refused(item => { item.files[0].sha256 = 'ABC'; return item; }, /SHA-256/);
  refused(item => { item.license = 'CC-BY-NC-4.0'; return item; }, /license must be one of MIT, Apache-2\.0/);
  refused(item => { item.script = 'run.sh'; return item; }, /unknown fields: script/);
  refused(item => { item.id = '../escape'; return item; }, /id must be/);
  assert.throws(() => parseEmbeddingModelsManifest(manifest([model('a'), model('b')])), /exactly one model must be recommended/);
  assert.throws(() => parseEmbeddingModelsManifest(manifest([model(), model()])), /repeats an id/);
  assert.deepEqual(diffEmbeddingModels(parseEmbeddingModelsManifest(manifest([model('a')])),
    parseEmbeddingModelsManifest(manifest([model('a', { memoryMb: 12 }), model('b', { recommended: false })], 2))),
  { fromVersion: 1, toVersion: 2, added: ['b'], removed: [], changed: ['a'] });
});

test('a download keeps a model only when every file has the size and digest the catalog names', async (t) => {
  const directory = workspace(t);
  const good = transport();
  const store = createEmbeddingModelStore({ directory, fetchImpl: good.fetchImpl });
  assert.deepEqual(store.installed(), []);
  assert.deepEqual(await store.download(model()), { id: 'tiny-zh', bytes: embeddingModelBytes(model()) });
  assert.deepEqual(store.installed(), [{ id: 'tiny-zh', revision: REVISION, dimensions: 16, bytes: embeddingModelBytes(model()) }]);
  assert.equal(good.calls.length, 3, 'the first source is enough');
  const spec = JSON.parse(readFileSync(join(directory, 'tiny-zh', MODEL_SPEC_FILE), 'utf8'));
  assert.deepEqual([spec.pooling, spec.lowercase, spec.stripAccents, spec.maxTokens], ['cls', true, false, 24]);
  assert.deepEqual(readFileSync(join(directory, 'tiny-zh', 'model.safetensors')), CONTENT['model.safetensors']);

  // The first source answers altered bytes: the mirror's copy is kept instead.
  const mirrored = transport(url => (url.startsWith('https://huggingface.co/') && url.endsWith('model.safetensors') ? Buffer.alloc(4096, 9) : null));
  await createEmbeddingModelStore({ directory, fetchImpl: mirrored.fetchImpl }).download(model('mirrored'));
  assert.equal(mirrored.calls.filter(url => url.includes('hf-mirror.com')).length, 1);

  // Every source altered, too long, or missing: nothing is kept and the failure is named.
  for (const [tamper, code] of [
    [url => (url.endsWith('vocab.txt') ? Buffer.from('other words') : null), 'embedding_model_altered'],
    [url => (url.endsWith('config.json') ? Buffer.alloc(64, 1) : null), 'embedding_model_altered'],
    [url => (url.endsWith('config.json') ? 404 : null), 'embedding_model_unavailable']]) {
    const failing = createEmbeddingModelStore({ directory, fetchImpl: transport(tamper).fetchImpl });
    await assert.rejects(failing.download(model('broken')), error => error.code === code);
    assert.equal(failing.progress('broken').status, 'failed');
    assert.equal(failing.progress('broken').reason, code);
  }
  assert.deepEqual(readdirSync(directory).sort(), ['mirrored', 'tiny-zh'], 'no partial folder is left behind');
  assert.deepEqual(store.remove('tiny-zh'), { id: 'tiny-zh', removed: true });
  assert.equal(existsSync(join(directory, 'tiny-zh')), false);
  assert.throws(() => store.remove('../mirrored'), /Unknown embedding model/);
});

// The real settings file and model port over a temporary directory; the graph service is a fake.
function installation(t, { fetchImpl = transport().fetchImpl } = {}) {
  const directory = workspace(t);
  const configPath = join(directory, 'model-backends.json');
  const embedded = [];
  const modelBackends = createModelBackendPort({
    readConfig: () => readModelBackendConfig(configPath), secrets: { read: async () => null }, ledger: new ModelUsageLedger(':memory:'),
    builtinEmbed: async ({ model: id, texts }) => {
      embedded.push({ id, texts });
      if (id === 'gone') throw Object.assign(new Error('missing'), { status: 404 });
      return { model: id, dimensions: 2, vectors: texts.map((_, index) => [index, 1]), tokens: 7 };
    } });
  const filled = [];
  const unloaded = [];
  const models = createEmbeddingModels({
    registry: { current: () => ({ manifest: parseEmbeddingModelsManifest(manifest([model(), model('other', { recommended: false })])),
      autoUpdate: true, lastCheckedAt: null }) },
    store: createEmbeddingModelStore({ directory: join(directory, 'models'), fetchImpl }),
    modelBackends, roleSettings: createModelRoleSettings(configPath),
    unload: async () => { unloaded.push(true); }, fillIndex: () => filled.push(true) });
  return { models, modelBackends, embedded, filled, unloaded, configPath };
}

const embedRequest = (personalProjectId = 'alpha') => ({ role: 'semantic', operation: 'knowledge_embedding', requestId: 'embed-1',
  scope: { personalSpaceId: 'space-synthetic', personalProjectId, sessionRef: null }, texts: ['Synthetic note.', 'Another synthetic note.'] });

test('a downloaded model becomes what search uses, with no key, no price and no project to approve', async (t) => {
  const { models, modelBackends, embedded, filled, unloaded, configPath } = installation(t);
  assert.deepEqual(models.list().models.map(item => [item.id, item.installed, item.inUse]), [['tiny-zh', false, false], ['other', false, false]]);
  assert.throws(() => models.use('tiny-zh'), error => error.code === 'embedding_model_not_downloaded');
  assert.throws(() => models.download('absent'), error => error.code === 'embedding_model_unknown');

  await models.download('tiny-zh', { useAfter: true }).done;
  const listed = models.list();
  assert.equal(listed.inUse, 'tiny-zh');
  assert.deepEqual(listed.models.map(item => [item.id, item.installed, item.inUse, item.download]),
    [['tiny-zh', true, true, null], ['other', false, false, null]]);
  assert.equal(filled.length, 1, 'the meaning index starts filling for the new model');
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.connections['builtin-embedding'], { protocol: 'builtin_embeddings', endpoint: 'http://127.0.0.1/builtin-embeddings',
    model: 'tiny-zh', secretRef: null, reasoningEffort: null, pricing: null });
  assert.deepEqual(saved.roles.semantic.egress, { approvedProjects: [], allowUnassigned: false });

  // Nothing leaves the computer, so every project's text may be embedded without an approval.
  assert.equal(modelBackends.allowsEgress(embedRequest('any-project')), true);
  const answer = await modelBackends.embed(embedRequest('any-project'));
  assert.deepEqual([answer.vectors, answer.dimensions, answer.model, answer.modelReceipt.status, answer.modelReceipt.usage.inputTokens],
    [[[0, 1], [1, 1]], 2, 'tiny-zh', 'completed', 7]);
  assert.deepEqual(embedded, [{ id: 'tiny-zh', texts: embedRequest().texts }]);

  // Downloading it again replaces the copy, after the graph service let go of the files.
  assert.equal(unloaded.length, 0);
  await models.download('tiny-zh').done;
  assert.equal(unloaded.length, 1);
  assert.equal(models.list().inUse, 'tiny-zh');

  // The model in use cannot be removed; another one can, and switching back and forth is one call.
  await assert.rejects(models.remove('tiny-zh'), error => error.code === 'embedding_model_in_use');
  await models.download('other').done;
  assert.equal(models.use('other').inUse, 'other');
  assert.deepEqual((await models.remove('tiny-zh')).models.map(item => [item.id, item.installed]), [['tiny-zh', false], ['other', true]]);
});

test('a built-in connection takes only its fixed local name, and a model that is gone is a named configuration failure', async (t) => {
  const read = connection => readModelBackendConfig('model-backends.json', { read: () => ({ version: 1,
    connections: { builtin: { protocol: 'builtin_embeddings', endpoint: 'http://127.0.0.1/builtin-embeddings', model: 'tiny-zh', ...connection } },
    roles: {} }) });
  assert.equal(read({}).state, 'ok');
  for (const change of [{ endpoint: 'https://example.com/v1' }, { secretRef: 'key-1' }, { headers: { 'X-A': 'b' } },
    { pricing: { currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 1 } }]) {
    assert.match(read(change).error, /is a built-in model/);
  }
  const { models, modelBackends } = installation(t);
  await models.download('tiny-zh', { useAfter: true }).done;
  const port = createModelBackendPort({
    readConfig: () => readModelBackendConfig('x', { read: () => ({ version: 1,
      connections: { builtin: { protocol: 'builtin_embeddings', endpoint: 'http://127.0.0.1/builtin-embeddings', model: 'gone' } },
      roles: { semantic: { enabled: true, connection: 'builtin', allowedOperations: ['knowledge_embedding'], budget: {} } } }) }),
    secrets: { read: async () => null }, ledger: new ModelUsageLedger(':memory:'),
    builtinEmbed: async () => { throw Object.assign(new Error('missing'), { status: 404 }); } });
  const gone = await port.embed(embedRequest());
  assert.deepEqual([gone.vectors, gone.modelReceipt.reason, gone.modelReceipt.failureClass], [null, 'model_not_downloaded', 'configuration']);
  const none = createModelBackendPort({ readConfig: () => readModelBackendConfig('x', { read: () => ({ version: 1,
    connections: { builtin: { protocol: 'builtin_embeddings', endpoint: 'http://127.0.0.1/builtin-embeddings', model: 'tiny-zh' } },
    roles: { semantic: { enabled: true, connection: 'builtin', allowedOperations: ['knowledge_embedding'], budget: {} } } }) }),
  secrets: { read: async () => null }, ledger: new ModelUsageLedger(':memory:') });
  assert.equal((await none.embed(embedRequest())).modelReceipt.reason, 'builtin_unavailable');
  assert.equal(modelBackends.allowsEgress(embedRequest()), true);
});

test('the console routes list, download, use and remove, and change nothing from another computer', async (t) => {
  const { models } = installation(t);
  const call = async (method, path, body = null, remoteAddress = '127.0.0.1') => {
    const sent = { status: null, body: null };
    const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = text ? JSON.parse(text) : null; } };
    const request = { method, socket: { remoteAddress }, headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const handled = await handleEmbeddingModelsRequest({ request, response, url: new URL(path, 'http://127.0.0.1'), embeddingModels: models });
    return { handled, ...sent };
  };
  assert.equal((await call('GET', '/api/embedding-models')).body.models.length, 2);
  assert.deepEqual([(await call('POST', '/api/embedding-models/download', { id: 'tiny-zh', use: true }, '192.168.1.9')).status], [403]);
  const started = await call('POST', '/api/embedding-models/download', { id: 'tiny-zh', use: true });
  assert.equal(started.status, 202);
  // The answer came at once; the list says when the download is whole and in use.
  for (let tries = 0; tries < 200 && models.list().inUse !== 'tiny-zh'; tries += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await call('GET', '/api/embedding-models')).body.inUse, 'tiny-zh');
  assert.equal((await call('POST', '/api/embedding-models/use', { id: 'tiny-zh' })).status, 200);
  await assert.rejects(call('POST', '/api/embedding-models/remove', { id: 'tiny-zh' }), error => error.code === 'embedding_model_in_use');
  await assert.rejects(call('POST', '/api/embedding-models/use', {}), /id of the model is required/);
  assert.equal((await call('GET', '/api/other')).handled, false);
  const off = { status: null };
  await handleEmbeddingModelsRequest({ request: { method: 'GET' }, response: { setHeader() {}, writeHead(status) { off.status = status; }, end() {} },
    url: new URL('/api/embedding-models', 'http://127.0.0.1'), embeddingModels: null });
  assert.equal(off.status, 503);
});
