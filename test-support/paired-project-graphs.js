import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { startGlobalSync, syncGlobalCopy } from '../src/runner/global-sync.js';
import { hostSpaceFrom, withHostConnection } from '../src/runner/host-space.js';
import { localGraphHealth, localGraphImport } from '../src/runner/local-graph-projects.js';
import { queueOwnerRecruitments } from '../src/runner/owner-recruitments.js';
import { cypher, startReplicaTestProvider } from './replica-neo4j.js';

function configure(dir, provider, principal, spaceId) {
  const path = join(dir, 'graph-runtime.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, personal: { providerUrl: provider.url, spaceId,
    accessToken: principal.access_token, principalId: principal.principal_id }, workspaces: [] }), { mode: 0o600 });
  return path;
}

// Simultaneous host and replica Providers, each backed by a different disposable graph.
export async function pairedProjectGraphs(t, seedHost) {
  const hostUri = process.env.FULI_TEST_NEO4J_URI;
  const followerUri = process.env.FULI_TEST_FOLLOWER_NEO4J_URI;
  assert.notEqual(new URL(hostUri).port, new URL(followerUri).port);
  const dir = mkdtempSync(join(tmpdir(), 'fuli-paired-graphs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const reviewToken = 'synthetic-paired-project-review';
  const provider = (uri, replica) => startReplicaTestProvider({ uri, replica, reviewToken, onStop: stop => t.after(stop) });
  let host = await provider(hostUri, false);
  const principal = await host.request('/v1/bootstrap', { principal_name: 'Synthetic host' });
  const space = await host.request('/v1/spaces', { name: 'Synthetic paired project', kind: 'personal' },
    { token: principal.access_token });
  await host.stop();
  host = await provider(hostUri, false);
  await seedHost({ request: host.request, token: principal.access_token, spaceId: space.id });
  const hostApp = openFederatedGraphApplication({ runtimeConfigPath: configure(dir, host, principal, space.id) });
  t.after(() => hostApp.close());
  return {
    hostApp, spaceId: space.id,
    hostRows: (query, parameters) => cypher(query, parameters, hostUri),
    async connectFollower(dataDir) {
      const own = await provider(followerUri, true);
      const account = await own.request('/v1/bootstrap', { principal_name: 'Synthetic follower' });
      await own.request('/v1/spaces', { name: 'Synthetic paired project', kind: 'personal', id: space.id,
        provider_id: 'global-copy-acceptance' }, { token: account.access_token });
      const configPath = configure(dataDir, own, account, space.id);
      writeFileSync(join(dataDir, 'graph-provider.env'), `FULI_PERSONAL_HUMAN_REVIEW_TOKEN=${reviewToken}\n`, { mode: 0o600 });
      const client = new GraphitiProviderClient({ baseUrl: own.url, accessToken: account.access_token });
      const formats = await localGraphHealth(configPath);
      return { spaceId: space.id, client: () => client, stop: own.stop,
        cypher: (query, parameters) => cypher(query, parameters, followerUri),
        round: () => withHostConnection(dataDir, { ownFormats: formats }, async ({ connection, store }) => {
          const sync = startGlobalSync({ dataDir, store, connection, providerRecorded: () => true,
            queueRecruitments: () => queueOwnerRecruitments({ app: { personal: client, config: { personal: { spaceId: space.id } } },
              store, sourceApplication: 'other', sessionId: 'follower-console' }) });
          try { return await sync.round(); } finally { await sync.close(); }
        }),
        sync: () => withHostConnection(dataDir, { ownFormats: formats }, async ({ connection, store }) => {
          let hostSpace;
          for (let attempt = 0; attempt < 20; attempt++) {
            hostSpace = hostSpaceFrom(await connection.hello());
            if (hostSpace.known) break;
            await delay(250);
          }
          return syncGlobalCopy({ dataDir, store, connection, hostSpace, ownFormats: formats, localSpaceId: space.id,
            verify: true, importInto: input => localGraphImport(configPath, input, { timeoutMs: 120_000 }) });
        })
      };
    }
  };
}
