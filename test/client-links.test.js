import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseClientLinksManifest } from '../src/client-links/manifest.js';
import { createClientLinksRegistry } from '../src/client-links/registry.js';
import { handleClientLinksRequest } from '../src/http/client-links-api-router.js';
import { mapHttpError } from '../src/http/error-mapping.js';
import { listenFetchableServer } from '../src/server/listen.js';

const BUNDLED = JSON.parse(readFileSync(new URL('../registry/client-links.json', import.meta.url), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));

function newer(change = manifest => manifest) {
  const manifest = copy(BUNDLED);
  manifest.manifestVersion = BUNDLED.manifestVersion + 1;
  manifest.updatedAt = '2026-10-28';
  return change(manifest);
}

// A synthetic next version: one client added, one changed, one removed.
const NEXT = newer(manifest => {
  manifest.clients = manifest.clients.filter(item => item.id !== 'kiro');
  manifest.clients.find(item => item.id === 'cursor').noSessionLink = 'Still no documented session link.';
  manifest.clients.push({ id: 'synthetic_client', name: 'Synthetic Client', sessionLinks: [{ id: 'synthetic-web',
    opens: 'Synthetic Web', template: 'https://synthetic.example/sessions/{sessionId}',
    parameters: { sessionId: { format: 'any' } }, platforms: ['web'], notes: 'Synthetic test link.',
    source: 'https://synthetic.example/docs' }], noSessionLink: null });
  return manifest;
});

function withRegistry(remote, run, { now = () => new Date('2026-10-27T08:00:00Z') } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-client-links-'));
  const fetches = [];
  const fetchImpl = async (url) => {
    fetches.push(url);
    if (remote instanceof Error) throw remote;
    return new Response(typeof remote === 'string' ? remote : JSON.stringify(remote), { status: 200 });
  };
  const registry = createClientLinksRegistry({ statePath: join(directory, 'client-links.json'), fetchImpl, now });
  return Promise.resolve(run(registry, fetches, directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('the bundled manifest is valid and says why a client has no link', () => {
  const manifest = parseClientLinksManifest(BUNDLED);
  const codex = manifest.clients.find(item => item.id === 'codex');
  assert.equal(codex.sessionLinks[0].template, 'codex://threads/{sessionId}');
  for (const item of manifest.clients) {
    assert.equal(item.sessionLinks.length === 0, typeof item.noSessionLink === 'string', item.id);
    for (const link of item.sessionLinks) assert.match(link.source, /^https:\/\//);
  }
});

test('a manifest with a script link, an unknown field or a broken entry is refused whole', () => {
  const link = manifest => manifest.clients[0].sessionLinks[0];
  const cases = [
    newer(manifest => { link(manifest).template = 'javascript:alert({sessionId})'; return manifest; }),
    newer(manifest => { link(manifest).template = 'JavaScript:alert({sessionId})'; return manifest; }),
    newer(manifest => { link(manifest).template = 'data:text/html,{sessionId}'; return manifest; }),
    newer(manifest => { link(manifest).template = 'http://example.com/{sessionId}'; return manifest; }),
    newer(manifest => { link(manifest).template = 'https://user:secret@example.com/{sessionId}'; return manifest; }),
    newer(manifest => { link(manifest).template = 'codex://threads/{other}'; return manifest; }),
    newer(manifest => { link(manifest).source = 'http://example.com/docs'; return manifest; }),
    newer(manifest => { link(manifest).run = 'calc.exe'; return manifest; }),
    newer(manifest => { manifest.clients[0].sessionLinks = []; return manifest; }),
    newer(manifest => { manifest.clients.push(copy(manifest.clients[0])); return manifest; }),
    newer(manifest => { manifest.formatVersion = 2; return manifest; }),
    newer(manifest => { manifest.manifestVersion = 0; return manifest; })
  ];
  for (const value of cases) assert.throws(() => parseClientLinksManifest(value), { code: 'client_links_invalid' });
});

test('checking shows what a newer manifest adds, changes and removes, and applying records it', async () => {
  await withRegistry(NEXT, async (registry, fetches) => {
    assert.equal(registry.current().source, 'bundled');
    const checked = await registry.check();
    assert.equal(fetches[0], 'https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/client-links.json');
    assert.equal(checked.status, 'update_available');
    assert.deepEqual(checked.diff.added, [{ id: 'synthetic_client', name: 'Synthetic Client' }]);
    assert.deepEqual(checked.diff.changed, [{ id: 'cursor', name: 'Cursor', fields: ['noSessionLink'] }]);
    assert.deepEqual(checked.diff.removed, [{ id: 'kiro', name: 'Kiro' }]);
    assert.throws(() => registry.apply('another-digest'), { code: 'client_links_changed', status: 409 });
    const applied = registry.apply(checked.digest);
    assert.equal(applied.source, 'updated');
    assert.equal(applied.manifest.manifestVersion, NEXT.manifestVersion);
    assert.deepEqual(applied.history.map(item => [item.automatic, item.fromVersion, item.toVersion]),
      [[false, BUNDLED.manifestVersion, NEXT.manifestVersion]]);
    assert.equal((await registry.check()).status, 'up_to_date');
  });
});

test('a failed fetch or an invalid copy keeps the current manifest', async () => {
  await withRegistry(new Error('offline'), async registry => {
    assert.equal((await registry.check()).status, 'unavailable');
    assert.equal(registry.current().source, 'bundled');
  });
  const unsafe = newer(manifest => { manifest.clients[0].sessionLinks[0].template = 'javascript:void({sessionId})'; return manifest; });
  for (const remote of [unsafe, '{not json']) {
    await withRegistry(remote, async registry => {
      const checked = await registry.check();
      assert.equal(checked.status, 'invalid');
      assert.equal(checked.digest, undefined);
      assert.equal(registry.current().manifest.manifestVersion, BUNDLED.manifestVersion);
    });
  }
});

test('auto-update checks at most once a day, only when turned on, and records that it applied', async () => {
  let clock = new Date('2026-10-27T08:00:00Z');
  await withRegistry(NEXT, async (registry, fetches) => {
    assert.equal(await registry.autoUpdate(), null);
    assert.equal(fetches.length, 0);
    registry.setAutoUpdate(true);
    const updated = await registry.autoUpdate();
    assert.equal(updated.source, 'updated');
    assert.equal(updated.history[0].automatic, true);
    clock = new Date('2026-10-27T20:00:00Z');
    assert.equal(await registry.autoUpdate(), null);
    assert.equal(fetches.length, 1);
    clock = new Date('2026-10-28T09:00:00Z');
    await registry.autoUpdate();
    assert.equal(fetches.length, 2);
  }, { now: () => clock });
});

test('the console reads, checks and applies the manifest over HTTP', async () => {
  await withRegistry(NEXT, async registry => {
    const server = createServer(async (request, response) => {
      try {
        if (!await handleClientLinksRequest({ request, response, url: new URL(request.url, 'http://local'), clientLinks: registry })) {
          response.writeHead(404).end();
        }
      } catch (error) {
        const mapped = mapHttpError(error);
        response.writeHead(mapped.status, { 'content-type': 'application/json' }).end(JSON.stringify(mapped.body));
      }
    });
    await listenFetchableServer(server, 0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body) => {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    try {
      assert.equal((await call('GET', '/api/client-links')).body.source, 'bundled');
      const checked = await call('POST', '/api/client-links/check');
      assert.equal(checked.body.status, 'update_available');
      assert.equal((await call('POST', '/api/client-links/apply', { digest: 'stale' })).status, 409);
      assert.equal((await call('POST', '/api/client-links/apply', { digest: checked.body.digest })).body.source, 'updated');
      assert.equal((await call('PUT', '/api/client-links/auto-update', { enabled: true })).body.autoUpdate, true);
      assert.equal((await call('PUT', '/api/client-links/auto-update', { enabled: 'yes' })).status, 400);
    } finally { server.close(); }
  });
});
