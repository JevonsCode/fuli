import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { reconcileLocalKnowledge } from '../src/knowledge-hard-delete/reconcile-local.js';
import { runMigrateCommand } from '../src/cli/migrate-command.js';
import { applyLocalSetup } from '../src/setup/setup.js';
import { formatSetupResult, runSetupCommand } from '../src/cli/setup-command.js';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'fuli-reconcile-synthetic-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const paths = { dataDir, graphRuntimeConfigPath: join(dataDir, 'graph-runtime.json') };
  writeFileSync(paths.graphRuntimeConfigPath, JSON.stringify({ version: 1,
    personal: { providerUrl: 'http://127.0.0.1:1', accessToken: 'synthetic-agent',
      principalId: 'synthetic-principal', spaceId: 'synthetic-space' }, workspaces: [] }));
  writeFileSync(join(dataDir, 'graph-provider.env'), 'FULI_PERSONAL_HUMAN_REVIEW_TOKEN=synthetic-review\n');
  return paths;
}

test('maintenance uses console reconciliation followed by ordinary-token watermark for the configured space', async (t) => {
  const paths = fixture(t);
  const calls = [];
  const result = await reconcileLocalKnowledge(paths, { fetchImpl: async (url, request) => {
    calls.push(new URL(url).pathname);
    assert.deepEqual(JSON.parse(request.body), { personal_space_id: 'synthetic-space' });
    assert.equal(request.headers.authorization, 'Bearer synthetic-agent');
    if (url.endsWith('/watermark')) {
      assert.equal(request.headers['x-fuli-human-review-token'], undefined);
      return Response.json({ count: 0, latest_deleted_at: null });
    }
    assert.equal(request.headers['x-fuli-human-review-token'], 'synthetic-review');
    return Response.json([]);
  } });
  assert.deepEqual(result, { status: 'ready' });
  assert.deepEqual(calls, ['/v1/knowledge/hard-deletions', '/v1/knowledge/hard-deletions/watermark']);
});

test('a missing proof or unavailable watermark stays pending without exposing provider details', async (t) => {
  const paths = fixture(t);
  for (const unavailable of [false, true]) {
    const result = await reconcileLocalKnowledge(paths, {
      createReconciler: () => ({ reconcile: async () => [] }),
      fetchImpl: async () => {
        if (unavailable) throw new Error('sensitive synthetic provider detail');
        return Response.json({ count: 1, latest_deleted_at: '2026-10-23T00:00:00Z' });
      }
    });
    assert.equal(result.status, 'pending');
    assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  }
});

test('failed reconciliation cannot report ready even when no graph deletions exist', async (t) => {
  const result = await reconcileLocalKnowledge(fixture(t), {
    createReconciler: () => ({ reconcile: async () => { throw new Error('private detail'); } }),
    fetchImpl: async () => { assert.fail('do not verify a failed reconciliation as ready'); }
  });
  assert.deepEqual(result, { status: 'pending', reason: 'reconciliation_unavailable' });
});

test('migrate reconciliation works noninteractively, holds maintenance, and reports pending with failure exit', async (t) => {
  const paths = fixture(t);
  for (const status of ['ready', 'pending']) {
    const events = [];
    const lines = [];
    const result = await runMigrateCommand(['reconcile-knowledge', '--data-dir', paths.dataDir], {
      env: {}, interactive: false, write: (line) => lines.push(line),
      maintenance: { hold: (dataDir) => {
        assert.equal(dataDir, paths.dataDir); events.push('held'); return () => events.push('released');
      } },
      reconcileKnowledge: async (received) => {
        assert.equal(received.dataDir, paths.dataDir); events.push('reconciled'); return { status };
      }
    });
    assert.deepEqual(events, ['held', 'reconciled', 'released']);
    assert.equal(result.exitCode, status === 'ready' ? 0 : 1);
    assert.match(lines.join('\n'), status === 'ready' ? /local stores are ready/ : /fuli migrate reconcile-knowledge/);
  }
});

test('successful setup reconciles after runtime initialization, including no-start, and pending blocks readiness', async (t) => {
  const paths = fixture(t);
  const plan = { paths, agents: [] };
  for (const status of ['ready', 'pending']) {
    const events = [];
    const result = await applyLocalSetup(plan, { noStart: true }, {
      ensureRuntime: async ({ noStart }) => {
        assert.equal(noStart, true); events.push('runtime'); return { status: 'initialized' };
      },
      reconcileKnowledge: async (received) => {
        assert.equal(received, paths); events.push('reconciled'); return { status };
      }
    });
    assert.deepEqual(events, ['runtime', 'reconciled']);
    assert.equal(result.status, status === 'ready' ? 'ready' : 'partial');
    assert.deepEqual(result.knowledgeRecovery, { status });
    const output = formatSetupResult(result, plan);
    if (status === 'pending') {
      assert.match(output, /fuli migrate reconcile-knowledge/);
      assert.doesNotMatch(output, /Fuli is ready|Agents are not connected/);
      const command = await runSetupCommand(['--yes'], { planSetup: () => plan,
        applySetup: async () => result, write: () => {} });
      assert.equal(command.exitCode, 1);
    }
  }
});

test('failed or cancelled setup never starts reconciliation', async (t) => {
  const plan = { paths: fixture(t), agents: [] };
  const reconcileKnowledge = async () => assert.fail('setup was not completed');
  await assert.rejects(applyLocalSetup(plan, {}, { reconcileKnowledge,
    ensureRuntime: async () => { throw new Error('synthetic runtime failure'); } }), /synthetic runtime failure/);
  const result = await runSetupCommand([], { planSetup: () => plan, reconcileKnowledge,
    confirm: async () => false, write: () => {}, applySetup: async () => assert.fail('cancelled') });
  assert.equal(result.status, 'cancelled');
});
