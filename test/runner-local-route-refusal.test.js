import assert from 'node:assert/strict';
import test from 'node:test';

import { localRouteRefusal } from '../src/runner/local-route-refusal.js';

// Whether this computer may own a scope on its own (local-route-refusal.js):
// open only for a project the host is not known to have, while this
// computer's runtime is ready under the host's space. Synthetic names only.
const SAME = { state: 'same', id: 'space-synthetic' };
const ready = (space = SAME) => ({ state: 'ready', running: false, projects: [], createdHere: true, space });

test('a new project opens only while this computer\'s runtime is ready under the host\'s space', () => {
  const rows = [
    ['global', ready(), 'global_has_one_owner'],
    ['default', ready(), 'default_stays'],
    ['project:on-host', ready(), 'project_on_host'],
    ['project:new', { state: 'not_prepared' }, 'local_runtime_not_ready'],
    ['project:new', { state: 'preparing', since: null }, 'local_runtime_not_ready'],
    ['project:new', { state: 'failed', code: 'disk_low' }, 'local_runtime_not_ready'],
    ['project:new', { state: 'failed', code: 'prepare_failed' }, 'local_runtime_not_ready'],
    ['project:new', { state: 'existing', space: { state: 'different' } }, 'local_space_differs'],
    ['project:new', ready({ state: 'different' }), 'local_space_differs'],
    ['project:new', ready({ state: 'later', reason: 'host_unreachable' }), 'local_space_not_yet'],
    ['project:new', ready({ state: 'later', reason: 'host_too_old' }), 'local_space_not_yet'],
    ['project:new', ready(), null],
    // The host is asked whether it has the project too (make-project-local.js); a project known to be its is never opened.
    ['project:on-host', { state: 'not_prepared' }, 'project_on_host']
  ];
  for (const [scope, localRuntime, code] of rows) {
    const said = localRouteRefusal({ scope, hostName: 'Host A', hostProjects: ['on-host'], localRuntime });
    assert.equal(said?.code ?? null, code, `${scope} ${JSON.stringify(localRuntime)}`);
    if (said) assert.match(said.message, /[a-z][\s\S]*\n[\s\S]*[一-鿿]/, 'both languages');
  }
});

test('a refusal says what to do now, never an internal code alone', () => {
  const waiting = localRouteRefusal({ scope: 'project:new', localRuntime: ready({ state: 'later', reason: 'host_unreachable' }) });
  assert.match(waiting.message, /once the host answers[\s\S]*连上主机后建/);
  const low = localRouteRefusal({ scope: 'project:new', localRuntime: { state: 'failed', code: 'disk_low' } });
  assert.match(low.message, /free disk space[\s\S]*磁盘空间不够/);
});
