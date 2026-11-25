import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { handoffWorkspace } from '../../src/agent-kits/handoff-workspace.js';

test('a client handoff opens only existing, known local directories', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folders = ['session', 'current', 'registered', 'legacy', 'reference', 'unknown'].map(name => join(root, name));
  for (const folder of folders) mkdirSync(folder);
  const [session, current, registered, legacy, reference, unknown] = folders;
  const file = join(root, 'file');
  writeFileSync(file, '');
  const app = {
    config: { personal: { spaceId: 'sample' } },
    roundtable: { knownProjectFolder: async () => current },
    listPersonalProjects: async () => [{ profile: { sources: [
      { kind: 'repository', role: 'own', uri: pathToFileURL(registered).href },
      { kind: 'repository', uri: legacy },
      { kind: 'repository', role: 'reference', uri: reference }
    ] } }]
  };
  const actor = { agentId: 'sample-agent', projectId: 'sample-project', client: 'codex', sessionId: 'sample-session' };
  const check = path => handoffWorkspace(app, actor, path, (client, id) => {
    assert.equal(client, actor.client);
    assert.equal(id, actor.sessionId);
    return session;
  });
  for (const path of [session, current, registered, legacy]) assert.equal(await check(path), realpathSync.native(path));
  for (const path of [reference, unknown, file, join(root, 'missing'), 'relative', root]) {
    await assert.rejects(check(path), { code: 'invalid_input' });
  }
});
