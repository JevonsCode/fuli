import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { applyConfirmedSqliteMigration, previewSqliteMigration } from '../packages/roundtable/src/storage/database-migration.js';
import { AGENT_APP_FORMAT, AgentAppStore } from '../src/agent-apps/store.js';
import { appRegistry, CLI_USER, events, FILES, MANIFEST, verifiedApp } from '../test-support/agent-app-hosts.js';

// rec#7 D-28.14 data deletion bound to the content digest and its four-step
// crash reconciliation; D-28.9 identity generations; D-28.3/4 manifest refusal.

async function codeDeleted(t, { content = 'synthetic' } = {}) {
  const registry = appRegistry(t);
  const host = registry.host({ pid: 101, ownerKind: 'cli' });
  const app = await verifiedApp(host);
  await host.service.start({ appId: app.appId });
  await host.service.stop({ appId: app.appId });
  const data = registry.dataOf(app.appId);
  writeFileSync(join(data, 'notes.json'), content);
  await host.service.deleteCode({ appId: app.appId, actor: CLI_USER });
  return { registry, host, appId: app.appId, data };
}

function setStatus(host, appId, status) {
  const { store } = host.context;
  store.transaction(() => store.saveApp({ ...store.existingApp(appId), status }));
}

test('a same-size rewrite after the export offer is caught by the content digest and must be confirmed again', async (t) => {
  const { host, appId, data } = await codeDeleted(t, { content: 'aaaa' });
  const offer = await host.service.prepareDataDeletion({ appId });
  writeFileSync(join(data, 'notes.json'), 'bbbb');

  await assert.rejects(host.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER }),
    { code: 'data_changed_reconfirm' });
  assert.equal(readFileSync(join(data, 'notes.json'), 'utf8'), 'bbbb');
  await assert.rejects(host.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER }),
    { code: 'deletion_ticket_invalid' });
  const again = await host.service.prepareDataDeletion({ appId });
  assert.equal((await host.service.deleteData({ appId, ticket: again.ticket, confirm: appId, actor: CLI_USER })).status, 'deleted');
  assert.equal(existsSync(data), false);
  assert.deepEqual(events(host, appId).slice(-3), ['data_deletion_offered', 'data_deleting', 'data_deleted']);
});

test('reconciliation finishes a deletion interrupted after the commit or the rename', async (t) => {
  const { host, appId, data } = await codeDeleted(t);
  // ① committed, ② renamed, ③ not done.
  setStatus(host, appId, 'data_deleting');
  const deleting = `${data}.deleting-0123456789abcdef`;
  mkdirSync(deleting);
  writeFileSync(join(deleting, 'notes.json'), 'synthetic');
  rmSync(data, { recursive: true, force: true });

  assert.equal((await host.service.stop({ appId })).status, 'stopped');
  assert.equal(host.service.read({ appId }).status, 'deleted');
  assert.equal(existsSync(deleting), false);
  assert.deepEqual(host.context.store.lastEvent(appId, 'data_deleted').detail, { reconciled: true });

  // ① committed, nothing on disk any more: only the record is missing.
  const second = await codeDeleted(t);
  setStatus(second.host, second.appId, 'data_deleting');
  rmSync(second.data, { recursive: true, force: true });
  await second.host.service.stop({ appId: second.appId });
  assert.equal(second.host.service.read({ appId: second.appId }).status, 'deleted');
});

test('a deletion interrupted before the rename returns to code_deleted and asks again', async (t) => {
  const { host, appId, data } = await codeDeleted(t);
  setStatus(host, appId, 'data_deleting');
  await host.service.stop({ appId });
  assert.equal(host.service.read({ appId }).status, 'code_deleted');
  assert.equal(readFileSync(join(data, 'notes.json'), 'utf8'), 'synthetic');
  assert.ok(events(host, appId).includes('data_deletion_interrupted'));
  await assert.rejects(host.service.approve({ appId, version: '9.9.9', digest: 'x', approver: CLI_USER }),
    { code: 'version_not_found' });
});

test('a data directory that reappears after deletion is kept and reported once', async (t) => {
  const { host, appId, data } = await codeDeleted(t);
  const offer = await host.service.prepareDataDeletion({ appId });
  await host.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER });
  mkdirSync(data);
  writeFileSync(join(data, 'restored.json'), 'synthetic');

  await host.service.stop({ appId });
  await host.service.stop({ appId });
  assert.equal(readFileSync(join(data, 'restored.json'), 'utf8'), 'synthetic');
  assert.equal(events(host, appId).filter((action) => action === 'orphan_data_directory').length, 1);
  assert.equal(host.service.list({}).apps[0].orphanDataDirectory, true);
});

test('a deleted identity comes back as a new generation; the tombstone and its id stay', async (t) => {
  const { host, appId } = await codeDeleted(t);
  const offer = await host.service.prepareDataDeletion({ appId });
  await host.service.deleteData({ appId, ticket: offer.ticket, confirm: appId, actor: CLI_USER });

  const again = await host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs', manifest: MANIFEST, files: FILES });
  assert.equal(again.appId, `${appId}-g2`);
  assert.equal(host.service.read({ appId }).status, 'deleted');
  assert.ok(events(host, appId).includes('identity_regenerated'));
  const stored = host.context.store.app(again.appId);
  assert.deepEqual([stored.identityKey, stored.generation, stored.status], [appId.slice(4), 2, 'pending']);
  assert.equal((await host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs', manifest: MANIFEST,
    files: FILES })).idempotent, true);
});

test('a manifest asking for network or a marked tool is rejected at submission, never stripped', async (t) => {
  const registry = appRegistry(t, { tools: ['agent_chat', 'review_with_tonborg', 'search_knowledge_graph'] });
  const host = registry.host({ pid: 101 });
  const submit = (manifest) => host.service.submit({ personalSpaceId: 'space-a', agentId: 'agent-jvs',
    manifest: { ...MANIFEST, ...manifest }, files: FILES });
  await assert.rejects(submit({ network: { allow: ['example.invalid'] } }),
    (error) => error.code === 'manifest_rejected' && error.status === 400 && /network/.test(error.message));
  await assert.rejects(submit({ permissions: ['fuli.agent_chat', 'fuli.review_with_tonborg'] }),
    (error) => error.code === 'manifest_rejected' && /agent_chat is marked egress, launch/.test(error.message)
      && /review_with_tonborg is marked model/.test(error.message));
  await assert.rejects(submit({ permissions: ['fuli.list_project_agents'] }), { code: 'permission_unavailable' });
  assert.equal((await submit({ permissions: ['fuli.search_knowledge_graph'] })).status, 'pending');
});

test('identity keys of existing apps are backfilled only after a person confirms the migration', async (t) => {
  const registry = appRegistry(t);
  const path = join(registry.root, 'registry.sqlite');
  mkdirSync(registry.root, { recursive: true });
  const version3 = AGENT_APP_FORMAT.migrations.slice(0, 2);
  const legacy = new DatabaseSync(path);
  legacy.exec(AGENT_APP_FORMAT.schema);
  for (const { table, columns } of version3) {
    for (const [name, type] of Object.entries(columns)) legacy.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  const appId = `app-${'b'.repeat(32)}`;
  legacy.prepare(`INSERT INTO agent_apps (app_id, provider, personal_space_id, agent_id, name, status, created_at, updated_at)
    VALUES (?, 'http://127.0.0.1:65530', 'space-a', 'agent-jvs', 'dispatch-log', 'pending', 'x', 'x')`).run(appId);
  legacy.exec('PRAGMA user_version = 3');
  legacy.close();

  assert.throws(() => void new AgentAppStore(path).database, { code: 'data_format_pending' });
  const plan = previewSqliteMigration(path, AGENT_APP_FORMAT);
  assert.equal(plan.step.id, 'agent-apps/7-identity-keys');
  assert.deepEqual(plan.step.sampleIds, [appId]);
  applyConfirmedSqliteMigration(path, AGENT_APP_FORMAT, { digest: plan.digest, actor: { entrypoint: 'cli' } });
  const store = new AgentAppStore(path);
  try {
    const app = store.app(appId);
    assert.deepEqual([app.identityKey, app.generation, app.instanceGeneration, store.owner(appId).fence],
      ['b'.repeat(32), 1, 0, 0]);
  } finally {
    store.close();
  }
});
