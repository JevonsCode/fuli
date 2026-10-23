import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { agentAppRoot, createAgentAppService } from '../src/agent-apps/service.js';
import { resolveSetupPaths } from '../src/setup/paths.js';

const LOCAL_USER = Object.freeze({ entrypoint: 'cli', user: 'fixture-user' });
const OWNERS = new Set(['space-a/agent-jvs', 'space-a/agent-dot']);
const MANIFEST = Object.freeze({
  schemaVersion: 1, name: 'dispatch-log', version: '1.0.0', title: 'Dispatch log',
  description: 'Synthetic fixture page that lists dispatched replies.',
  permissions: ['fuli.resolve_knowledge_tags'],
  runtime: { apiVersion: 1, entry: 'service/main.js', webRoot: 'web' },
  data: { scope: 'app', format: 1 }
});
const FILES = Object.freeze([
  { path: 'web/index.html', content: '<h1>Synthetic dispatch log</h1>' },
  { path: 'service/main.js', content: 'export const synthetic = true;\n' }
]);

function fixture(t, { root } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-agent-app-packages-'));
  const appRoot = root?.(dataDir) ?? join(dataDir, 'agent-apps');
  const clock = { now: Date.parse('2026-10-20T08:00:00.000Z') };
  const tools = ['resolve_knowledge_tags', 'list_personal_projects', 'agent_chat'];
  const service = createAgentAppService({
    root: appRoot,
    providerIdentity: 'http://127.0.0.1:65530/',
    resolveOwner: async ({ personalSpaceId, agentId }) => {
      if (!OWNERS.has(`${personalSpaceId}/${agentId}`)) {
        throw Object.assign(new Error('Project Agent not found'), { status: 404 });
      }
      return { personalSpaceId, agentId };
    },
    toolNames: () => tools,
    clock: () => new Date(clock.now),
    // The run gate's answers below are Windows's, the one platform with a presence check.
    platform: 'win32',
    // A synthetic host process: nothing real is probed.
    hostIdentity: { platform: 'test', self: async () => ({ pid: 101, identity: 'test:101', exePath: '/synthetic/node' }),
      probe: async () => 'unknown' }
  });
  // The registry database must close before Windows lets its directory go.
  t.after(() => {
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, root: appRoot, service, clock, tools };
}

function submission({ agentId = 'agent-jvs', manifest = {}, files = FILES } = {}) {
  return { personalSpaceId: 'space-a', agentId, manifest: { ...MANIFEST, ...manifest }, files };
}

const approval = ({ appId, version, digest }, extra = {}) => ({ appId, version, digest, approver: LOCAL_USER, ...extra });

function tree(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true }).map(String).sort()
    .filter((path) => statSync(join(directory, path)).isFile())
    .map((path) => [path.split('\\').join('/'), readFileSync(join(directory, path), 'utf8')]);
}

test('a submitted version stays pending, immutable and unable to run until approved', async (t) => {
  const { service, root } = fixture(t);

  const submitted = await service.submit(submission());

  assert.match(submitted.appId, /^app-[0-9a-f]{32}$/);
  assert.equal(submitted.status, 'pending');
  assert.match(submitted.digest, /^[0-9a-f]{64}$/);
  assert.match(submitted.approval, new RegExp(`fuli app approve ${submitted.appId} 1\\.0\\.0`));
  assert.equal(service.read({ appId: submitted.appId }).run.reason, 'presence_unverified');
  assert.deepEqual(service.list({ personalSpaceId: 'space-a' }).apps.map(
    ({ appId, agentId, name, type, status, version, pendingVersions }) =>
      ({ appId, agentId, name, type, status, version, pendingVersions })), [{
    appId: submitted.appId, agentId: 'agent-jvs', name: 'dispatch-log', type: 'page',
    status: 'pending', version: null, pendingVersions: ['1.0.0']
  }]);

  const again = await service.submit(submission());
  assert.equal(again.digest, submitted.digest);
  assert.equal(again.idempotent, true);
  await assert.rejects(service.submit(submission({
    files: [{ path: 'web/index.html', content: '<h1>Swapped</h1>' }, FILES[1]]
  })), { code: 'version_exists' });
  assert.equal(readFileSync(join(root, 'packages', submitted.appId, '1.0.0', 'web', 'index.html'), 'utf8'),
    FILES[0].content);
  assert.equal(existsSync(join(root, 'data', submitted.appId)), false);
});

test('approval binds the submitted digest and refuses a package changed before or after approval', async (t) => {
  const { service, root } = fixture(t);
  const first = await service.submit(submission());

  await assert.rejects(service.approve(approval({ ...first, digest: '0'.repeat(64) })),
    { code: 'digest_mismatch' });
  writeFileSync(join(root, 'packages', first.appId, '1.0.0', 'web', 'index.html'), '<h1>Swapped on disk</h1>');
  await assert.rejects(service.approve(approval(first)), { code: 'package_tampered' });
  assert.equal(service.read({ appId: first.appId }).status, 'pending');

  const second = await service.submit(submission({ manifest: { version: '1.0.1' } }));
  const approved = await service.approve(approval(second));
  assert.equal(approved.status, 'active');
  const recorded = service.read({ appId: second.appId }).versions.find(({ version }) => version === '1.0.1');
  assert.equal(recorded.state, 'approved');
  assert.deepEqual(recorded.approval, {
    digest: second.digest, approvedBy: 'fixture-user', entrypoint: 'cli', presence: 'unverified', verification: null, challengeId: null,
    verifiedAt: null, approvedAt: '2026-10-20T08:00:00.000Z',
    permissions: ['fuli.resolve_knowledge_tags'], data: { scope: 'app', format: 1, accepts: [1], migration: 'none' },
    resident: false
  });
});

test('an approved version records an unverified presence and still has no way to run', async (t) => {
  const { service } = fixture(t);
  const submitted = await service.submit(submission());
  await assert.rejects(service.approve(approval(submitted, { approver: { channel: 'cli', user: 'fixture-user' } })),
    TypeError);

  const approved = await service.approve(approval(submitted));

  assert.equal(approved.status, 'active');
  assert.deepEqual(approved.approval, { entrypoint: 'cli', presence: 'unverified' });
  assert.deepEqual(service.list({}).apps[0].approval, {
    approvedBy: 'fixture-user', entrypoint: 'cli', presence: 'unverified', verification: null, challengeId: null,
    verifiedAt: null, approvedAt: '2026-10-20T08:00:00.000Z'
  });
  const detail = service.read({ appId: submitted.appId });
  assert.equal(detail.versions[0].approval.presence, 'unverified');
  assert.deepEqual(detail.history.find(({ action }) => action === 'approved').detail,
    { digest: submitted.digest, entrypoint: 'cli', presence: 'unverified' });
  // Tokens exist only for a started instance; an unverified approval never starts.
  assert.deepEqual(Object.keys(service).sort(), ['approve', 'authorizeCall', 'callTool', 'close', 'deleteCode',
    'deleteData', 'disable', 'exportData', 'list', 'prepareDataDeletion', 'read', 'rollback', 'start', 'stop', 'submit']);
  assert.equal((await service.start({ appId: submitted.appId })).reason, 'presence_unverified');

  await service.disable({ appId: submitted.appId, actor: { entrypoint: 'http', user: 'local-console' } });
  await service.rollback({ appId: submitted.appId, version: '1.0.0', actor: LOCAL_USER });
  await service.deleteCode({ appId: submitted.appId, actor: LOCAL_USER });
  assert.deepEqual(service.read({ appId: submitted.appId }).history.slice(-3).map(({ action, detail: { entrypoint, presence } }) =>
    ({ action, entrypoint, presence })), [
    { action: 'disabled', entrypoint: 'http', presence: 'unverified' },
    { action: 'enabled', entrypoint: 'cli', presence: 'unverified' },
    { action: 'code_deleted', entrypoint: 'cli', presence: 'unverified' }
  ]);
});

test('a resident service needs its own confirmation on top of the package approval', async (t) => {
  const { service } = fixture(t);
  const submitted = await service.submit(submission({ manifest: { resident: true } }));

  await assert.rejects(service.approve(approval(submitted)), { code: 'resident_confirmation_required' });
  assert.equal(service.read({ appId: submitted.appId }).status, 'pending');
  assert.equal((await service.approve(approval(submitted, { confirmResident: true }))).status, 'active');
  assert.equal(service.list({}).apps[0].type, 'service');
  assert.equal(service.read({ appId: submitted.appId }).versions[0].approval.resident, true);
});

test('two Agents with the same app name own separate apps', async (t) => {
  const { service } = fixture(t);
  const jvs = await service.submit(submission({ agentId: 'agent-jvs' }));
  const dot = await service.submit(submission({ agentId: 'agent-dot' }));

  assert.notEqual(jvs.appId, dot.appId);
  for (const bare of ['agent-jvs', 'agent-dot', 'dispatch-log']) assert.equal(jvs.appId.includes(bare), false);
  await service.approve(approval(jvs));
  assert.equal(service.read({ appId: jvs.appId }).status, 'active');
  assert.equal(service.read({ appId: dot.appId }).status, 'pending');
  assert.deepEqual(service.list({ agentId: 'agent-dot' }).apps.map(({ appId }) => appId), [dot.appId]);
  await assert.rejects(service.submit(submission({ agentId: 'agent-unknown' })), { code: 'owner_not_found' });
});

test('package files cannot escape the package root or arrive as links', async (t) => {
  const { service, root, dataDir } = fixture(t);
  for (const path of ['../escape.js', '/absolute.js', 'C:/absolute.js', 'C:relative.js', 'web\\index2.html',
    'web/../../escape.js', './web/a.js', 'web//a.js', '.env', 'web/.hidden', 'app.json', 'web/CON.js',
    'web/nul', 'web/trailing.', '~/home.js']) {
    await assert.rejects(service.submit(submission({ files: [...FILES, { path, content: 'x' }] })),
      { code: 'invalid_package' }, path);
  }
  await assert.rejects(service.submit(submission({
    files: [...FILES, { path: 'web/linked', content: '', symlink: '../../outside' }]
  })), { code: 'invalid_package' });
  await assert.rejects(service.submit(submission({ files: [...FILES, { path: 'WEB/Index.html', content: 'x' }] })),
    { code: 'invalid_package' });
  await assert.rejects(service.submit(submission({ files: [...FILES, { path: 'web', content: 'x' }] })),
    { code: 'invalid_package' });
  await assert.rejects(service.submit(submission({ manifest: { runtime: { apiVersion: 1, entry: 'service/missing.js' } } })),
    { code: 'invalid_package' });
  await assert.rejects(service.submit(submission({ files: [...FILES, {
    path: 'web/large.bin', content: Buffer.alloc(1024 * 1024).toString('base64'), encoding: 'base64'
  }] })), { code: 'package_too_large' });
  assert.equal(existsSync(join(root, 'packages')), false);

  const submitted = await service.submit(submission());
  const outside = join(dataDir, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(root, 'packages', submitted.appId, '1.0.0', 'web', 'linked'), 'junction');
  await assert.rejects(service.approve(approval(submitted)), { code: 'package_tampered' });
});

test('activation checks the data format and the current authorization before any rollback', async (t) => {
  const { service, tools } = fixture(t);
  const v1 = await service.submit(submission());
  const { appId } = v1;
  await service.approve(approval(v1));
  const v2 = await service.submit(submission({ manifest: { version: '2.0.0',
    data: { scope: 'app', format: 2, accepts: [1, 2], migration: 'irreversible' } } }));

  await assert.rejects(service.approve(approval(v2)), { code: 'migration_confirmation_required' });
  assert.equal(service.read({ appId }).version, '1.0.0');
  const migrated = await service.approve(approval(v2, { confirmIrreversibleMigration: true }));
  assert.deepEqual({ ...migrated.dataMigration, note: undefined }, { from: 1, to: 2, irreversible: true, note: undefined });
  assert.match(migrated.dataMigration.note, /rolling back code does not restore/i);

  await assert.rejects(service.rollback({ appId, version: '1.0.0', actor: LOCAL_USER }), { code: 'data_format_incompatible' });
  assert.equal(service.read({ appId }).version, '2.0.0');

  const v3 = await service.submit(submission({ manifest: { version: '3.0.0', permissions: [],
    data: { scope: 'app', format: 2 } } }));
  await service.approve(approval(v3));
  tools.splice(tools.indexOf('resolve_knowledge_tags'), 1);
  await assert.rejects(service.rollback({ appId, version: '2.0.0', actor: LOCAL_USER }), { code: 'permission_unavailable' });
  assert.equal(service.read({ appId }).version, '3.0.0');

  const v4 = await service.submit(submission({ manifest: { version: '4.0.0', permissions: [],
    data: { scope: 'app', format: 3, accepts: [2, 3], migration: 'reversible' } } }));
  assert.equal((await service.approve(approval(v4))).dataMigration.irreversible, false);
  await assert.rejects(service.submit(submission({ manifest: { version: '5.0.0', permissions: ['fuli.not_a_tool'] } })),
    { code: 'permission_unavailable' });
});

test('deleting an app takes two explicit steps and keeps only a content-free record', async (t) => {
  const { service, root, dataDir, clock } = fixture(t);
  const v1 = await service.submit(submission());
  const { appId } = v1;
  await service.approve(approval(v1));
  const appData = join(root, 'data', appId);
  mkdirSync(appData, { recursive: true });
  writeFileSync(join(appData, 'blacklist.json'), '["synthetic-sender"]');

  await assert.rejects(service.prepareDataDeletion({ appId }), { code: 'code_deletion_required' });
  const step1 = await service.deleteCode({ appId, actor: LOCAL_USER });
  assert.equal(step1.status, 'code_deleted');
  assert.equal(step1.dataKept, true);
  assert.equal(existsSync(join(root, 'packages', appId)), false);
  assert.equal(readFileSync(join(appData, 'blacklist.json'), 'utf8'), '["synthetic-sender"]');
  assert.ok(service.read({ appId }).dataBytes > 0);

  const restored = await service.submit(submission({ manifest: { version: '1.0.1' } }));
  assert.equal(restored.appId, appId);
  await service.approve(approval(restored));
  assert.equal(service.read({ appId }).status, 'active');
  assert.equal(readFileSync(join(appData, 'blacklist.json'), 'utf8'), '["synthetic-sender"]');
  await service.deleteCode({ appId, actor: LOCAL_USER });

  const stale = await service.prepareDataDeletion({ appId });
  clock.now += 11 * 60_000;
  await assert.rejects(service.deleteData({ appId, ticket: stale.ticket, confirm: appId, actor: LOCAL_USER }),
    { code: 'deletion_ticket_expired' });
  const offer = await service.prepareDataDeletion({ appId });
  assert.match(offer.export, new RegExp(`fuli app export ${appId} --output `));
  assert.equal(offer.confirm, appId);
  assert.ok(offer.dataBytes > 0);
  await assert.rejects(service.deleteData({ appId, ticket: offer.ticket, confirm: 'yes', actor: LOCAL_USER }),
    { code: 'deletion_confirmation_required' });
  await assert.rejects(service.deleteData({ appId, ticket: 'not-the-ticket', confirm: appId, actor: LOCAL_USER }),
    { code: 'deletion_ticket_invalid' });
  assert.equal(existsSync(join(appData, 'blacklist.json')), true);

  const exportDir = join(dataDir, 'export');
  assert.equal((await service.exportData({ appId, destination: exportDir })).files, 1);
  assert.equal(readFileSync(join(exportDir, 'blacklist.json'), 'utf8'), '["synthetic-sender"]');

  const record = await service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: LOCAL_USER });
  assert.equal(record.status, 'deleted');
  assert.equal(existsSync(appData), false);
  const kept = service.read({ appId });
  assert.equal(kept.status, 'deleted');
  assert.deepEqual(kept.versions, []);
  assert.ok(kept.history.some(({ action }) => action === 'data_deleted'));
  const text = JSON.stringify(kept);
  for (const content of ['Synthetic', 'Dispatch log', 'synthetic-sender', 'blacklist', 'index.html']) {
    assert.equal(text.includes(content), false, content);
  }
});

test('version changes never rewrite the app data directory', async (t) => {
  const { service, root } = fixture(t);
  const v1 = await service.submit(submission());
  const { appId } = v1;
  await service.approve(approval(v1));
  const appData = join(root, 'data', appId);
  mkdirSync(join(appData, 'logs'), { recursive: true });
  writeFileSync(join(appData, 'blacklist.json'), '["synthetic-sender"]');
  writeFileSync(join(appData, 'logs', '2026-10-20.jsonl'), '{"reply":"synthetic"}\n');
  const before = tree(appData);

  const v2 = await service.submit(submission({ manifest: { version: '1.1.0' },
    files: [{ path: 'web/index.html', content: '<h1>Synthetic v2</h1>' }, FILES[1]] }));
  await service.approve(approval(v2));
  await service.rollback({ appId, version: '1.0.0', actor: LOCAL_USER });
  await service.disable({ appId, actor: LOCAL_USER });
  await service.rollback({ appId, version: '1.1.0', actor: LOCAL_USER });
  await service.submit(submission({ manifest: { version: '1.2.0' } }));
  await service.deleteCode({ appId, actor: LOCAL_USER });

  assert.deepEqual(tree(appData), before);
});

test('apps live outside the read-only Agent directory projection, which they never write', async (t) => {
  const { service, dataDir } = fixture(t, { root: (directory) => agentAppRoot(join(directory, 'graph-runtime.json')) });
  const projection = resolveSetupPaths({ dataDir }).agentDirectoryRoot;
  assert.equal(agentAppRoot(join(dataDir, 'graph-runtime.json')), join(dataDir, 'agent-apps'));
  assert.match(relative(projection, join(dataDir, 'agent-apps')), /^\.\./);
  mkdirSync(join(projection, 'provider', 'space', 'agent'), { recursive: true });
  writeFileSync(join(projection, 'provider', 'space', 'agent', 'AGENTS.md'), 'Generated synthetic projection\n');
  const before = tree(projection);

  const submitted = await service.submit(submission());
  await service.approve(approval(submitted));
  await service.deleteCode({ appId: submitted.appId, actor: LOCAL_USER });
  const offer = await service.prepareDataDeletion({ appId: submitted.appId });
  await service.deleteData({ appId: submitted.appId, ticket: offer.ticket, confirm: submitted.appId, actor: LOCAL_USER });

  assert.deepEqual(tree(projection), before);
});
