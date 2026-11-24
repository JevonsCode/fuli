import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createDeviceCertificate } from '../packages/roundtable/src/peer/device-identity.js';
import { runGraphDataCommand } from '../src/cli/graph-data-command.js';
import { openRoutes } from '../src/runner/call-routes.js';
import { readGlobalCopyRecord } from '../src/runner/global-copy-state.js';
import { enabled, OWNER, replicaFixture } from '../test-support/replica-neo4j.js';

// Only the dedicated database service handed to this CI job can be stopped. The
// service is restarted and its readiness checked before the next test uses it.
const service = process.env.FULI_TEST_NEO4J_CONTAINER;
const docker = (...args) => promisify(execFile)('docker', args, { timeout: 120_000 });

test('a whole-graph restore returns the local project and replica to the backup, then verifies the copy',
  { skip: !enabled || !service, timeout: 300_000 }, async t => {
    assert.match(service, /^[0-9a-f]{12,64}$/);
    const fixture = await replicaFixture(t);
    const { dataDir, spaceId } = fixture;
    assert.equal((await fixture.sync(true)).outcome, 'synced');
    await fixture.project('in-backup');
    const routes = openRoutes(dataDir);
    routes.setLocalProject('project:in-backup', null);
    routes.close();
    await mkdir(join(dataDir, 'peer'), { recursive: true });
    await writeFile(join(dataDir, 'peer/device-cert.pem'), (await createDeviceCertificate()).certPem);
    const image = (await docker('inspect', '--format', '{{.Config.Image}}', service)).stdout.trim();
    const helper = `fuli-offline-copy-${randomUUID()}`;
    await docker('run', '-d', '--name', helper, '--volumes-from', service, '--entrypoint', 'sleep', image, '1800');
    t.after(() => docker('rm', '-f', helper));
    let offline = false;
    async function online() {
      if (!offline) return;
      await docker('start', service);
      for (let check = 0; check < 90; check++) {
        const { stdout } = await docker('inspect', '--format', '{{.State.Health.Status}}', service);
        if (stdout.trim() === 'healthy') {
          offline = false;
          await fixture.restart(true);
          return;
        }
        await delay(1000);
      }
      throw new Error('The disposable database did not restart.');
    }
    t.after(online);
    const admin = (...args) => docker('exec', '--user', '7474:7474', helper, 'neo4j-admin', 'database', ...args);
    const adapter = { instances: ['personal'], selection: () => ({ personalSpaceId: spaceId }),
      async stop() { await fixture.stop(); offline = true; await docker('stop', service); return { resume: true }; },
      start: online,
      async dump(_id, file) {
        await admin('dump', 'neo4j', '--to-path=/tmp', '--overwrite-destination=true');
        await docker('cp', `${helper}:/tmp/neo4j.dump`, file);
      },
      async load(_id, file) {
        await docker('cp', file, `${helper}:/tmp/neo4j.dump`);
        await docker('exec', '--user', '0', helper, 'chown', '7474:7474', '/tmp/neo4j.dump');
        await admin('load', 'neo4j', '--from-path=/tmp', '--overwrite-destination=true');
      } };
    const deps = { runtime: { consoleRunning: async () => false }, createAdapter: async () => adapter,
      interactive: true, confirm: async () => true, write: () => {} };
    const backup = join(dataDir, 'backup');
    await runGraphDataCommand('export', ['--data-dir', dataDir, '--output', backup], deps);
    await fixture.project('after-backup');
    await runGraphDataCommand('import', ['--data-dir', dataDir, '--input', backup], deps);
    const projects = await fixture.client().listPersonalProjects(spaceId);
    assert.ok(projects.some(project => project.project_id === 'in-backup'));
    assert.ok(!projects.some(project => project.project_id === 'after-backup'));
    assert.equal((await fixture.client().health()).globalReplica, true);
    const before = performance.now();
    const summary = await fixture.client().replicaSummary({ personalSpaceId: spaceId, scope: 'global' });
    t.diagnostic(`Local replica summary: ${summary.copiedRecords} records in ${Math.round(performance.now() - before)} ms`);
    assert.deepEqual(summary.owners, [OWNER]);
    assert.equal(readGlobalCopyRecord(dataDir).digest, null);
    assert.ok((await fixture.sync(false)).imported);
  });
