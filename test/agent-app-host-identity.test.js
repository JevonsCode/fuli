import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createHostIdentity } from '../src/agent-apps/host-identity.js';
import { HOST_TOOL_CATALOG } from '../src/agent-apps/host-tools/catalog.js';
import { listAgentTools } from '../src/agent-tools.js';
import { reachableModules } from '../test-support/module-graph.js';

// rec#7 D-28.25, D-28.29, D-28.30, rec#11 D-36: whether a FULI host process
// still exists. Synthetic /proc and ps answers for the logic; a real probe only
// of a trivial node child this test starts and that exits on its own.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOOT = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

function fakeProc({ namespace = '4026531836', boot = BOOT, stats = {} } = {}) {
  return {
    readLink: (path) => {
      if (path !== '/proc/self/ns/pid' || namespace === null) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
      return `pid:[${namespace}]`;
    },
    readText: (path) => {
      if (path === '/proc/sys/kernel/random/boot_id' && boot !== null) return `${boot}\n`;
      const pid = /^\/proc\/(\d+)\/stat$/.exec(path)?.[1];
      if (pid && stats[pid]) return stats[pid];
      throw Object.assign(new Error('synthetic'), { code: 'ENOENT' });
    }
  };
}

// A stat line whose command contains ") " so only the last ")" separates it.
const stat = (pid, state, starttime) => `${pid} (node) worker) ${state} 1 ${pid} ${pid} 0 -1 4194560 `
  + `${Array.from({ length: 12 }, () => '0').join(' ')} ${starttime} 1000 50 18446744073709551615`;

// One mock of process.kill per test, restored when the test ends; answer()
// changes what it says. A second mock of the same method in one test would
// not be undone and would leak into later tests.
function mockKill(t, code = null) {
  let answer = code;
  const mock = t.mock.method(process, 'kill', () => {
    if (answer) throw Object.assign(new Error('synthetic'), { code: answer });
    return true;
  });
  return Object.assign(mock, { answer: (next) => { answer = next; } });
}

const linuxIdentity = (starttime, namespace = '4026531836') => `linux:${BOOT}:${namespace}:${starttime}`;

test('Linux: an exact boot, namespace and start time is alive; any difference or zombie is exited', async (t) => {
  const kill = mockKill(t);
  const host = createHostIdentity({ platform: 'linux', procfs: fakeProc({ stats: { 4242: stat(4242, 'S', 98765) } }) });
  assert.equal(await host.probe({ pid: 4242, identity: linuxIdentity(98765) }), 'alive');
  // T7: the PID now names a process that started at another time.
  assert.equal(await host.probe({ pid: 4242, identity: linuxIdentity(98764) }), 'exited');
  assert.equal(await host.probe({ pid: 4242, identity: `linux:00000000-0000-0000-0000-000000000000:4026531836:98765` }), 'exited');
  const zombie = createHostIdentity({ platform: 'linux', procfs: fakeProc({ stats: { 4242: stat(4242, 'Z', 98765) } }) });
  assert.equal(await zombie.probe({ pid: 4242, identity: linuxIdentity(98765) }), 'exited');
  assert.deepEqual(kill.mock.calls.map(({ arguments: [, signal] }) => signal), [0, 0, 0]);
});

test('T14 Linux: another PID namespace is unknown even when the PID is absent here', async (t) => {
  const kill = mockKill(t, 'ESRCH');
  const host = createHostIdentity({ platform: 'linux', procfs: fakeProc() });
  assert.equal(await host.probe({ pid: 4242, identity: linuxIdentity(98765, '4026532000') }), 'unknown');
  const unreadable = createHostIdentity({ platform: 'linux', procfs: fakeProc({ namespace: null }) });
  assert.equal(await unreadable.probe({ pid: 4242, identity: linuxIdentity(98765) }), 'unknown');
  assert.equal(kill.mock.callCount(), 0, 'no exit evidence is looked at before the namespace check');
  // Same namespace: ESRCH is exit evidence.
  assert.equal(await host.probe({ pid: 4242, identity: linuxIdentity(98765) }), 'exited');
});

test('T9 Linux: a process table that cannot be read is unknown', async (t) => {
  const kill = mockKill(t);
  const host = createHostIdentity({ platform: 'linux', procfs: fakeProc() });
  assert.equal(await host.probe({ pid: 4242, identity: linuxIdentity(98765) }), 'unknown');
  const noBoot = createHostIdentity({ platform: 'linux', procfs: fakeProc({ boot: null, stats: { 4242: stat(4242, 'S', 1) } }) });
  assert.equal(await noBoot.probe({ pid: 4242, identity: linuxIdentity(1) }), 'unknown');
  kill.answer('EINVAL');
  const before = kill.mock.callCount();
  assert.equal(await createHostIdentity({ platform: 'linux', procfs: fakeProc({ stats: { 4242: stat(4242, 'S', 1) } }) })
    .probe({ pid: 4242, identity: linuxIdentity(1) }), 'unknown');
  assert.equal(kill.mock.callCount(), before + 1);
});

test('T8 an identity from another platform is unknown and nothing is asked of the OS', async (t) => {
  const kill = mockKill(t, 'ESRCH');
  const windows = { created: async () => { throw new Error('not asked'); }, probe: async () => { throw new Error('not asked'); } };
  for (const platform of ['linux', 'darwin', 'win32']) {
    const host = createHostIdentity({ platform, procfs: fakeProc(), windows, readPsState: async () => 'Z' });
    for (const identity of [linuxIdentity(1), 'win32:133700000000000000', 'darwin:unverified', null, 'test:1']) {
      if (identity?.startsWith(`${platform}:`)) continue;
      assert.equal(await host.probe({ pid: 4242, identity }), 'unknown', `${platform} ${identity}`);
    }
  }
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(await createHostIdentity({ platform: 'freebsd' }).probe({ pid: 1, identity: 'freebsd:1' }), 'unknown');
});

test('macOS: only ESRCH or a zombie is evidence; a live process is unknown, not alive', async (t) => {
  const host = (state) => createHostIdentity({ platform: 'darwin', readPsState: async () => state });
  const kill = mockKill(t);
  assert.equal((await host('S').self()).identity, 'darwin:unverified');
  assert.equal(await host('Ss').probe({ pid: 4242, identity: 'darwin:unverified' }), 'unknown');
  assert.equal(await host('Z+').probe({ pid: 4242, identity: 'darwin:unverified' }), 'exited');
  assert.equal(await host(null).probe({ pid: 4242, identity: 'darwin:unverified' }), 'unknown');
  kill.answer('ESRCH');
  assert.equal(await host('S').probe({ pid: 4242, identity: 'darwin:unverified' }), 'exited');
});

test('Windows: the creation time is compared exactly and every failure is unknown', async () => {
  const answers = { alive: 'alive', exited: 'exited', denied: 'unknown', odd: 'maybe' };
  const windows = { created: async () => '133700000000000123', probe: async (pid) => answers[pid === 1 ? 'alive' : pid === 2 ? 'exited' : pid === 3 ? 'denied' : 'odd'] };
  const host = createHostIdentity({ platform: 'win32', windows });
  assert.equal((await host.self()).identity, 'win32:133700000000000123');
  assert.deepEqual(await Promise.all([1, 2, 3, 4].map((pid) => host.probe({ pid, identity: 'win32:133700000000000123' }))),
    ['alive', 'exited', 'unknown', 'unknown']);
  assert.equal(await host.probe({ pid: 1, identity: 'win32:not-a-filetime' }), 'unknown');
  const failing = createHostIdentity({ platform: 'win32', windows: { created: async () => { throw new Error('x'); },
    probe: async () => { throw new Error('x'); } } });
  assert.equal((await failing.self()).identity, null);
  assert.equal(await failing.probe({ pid: 1, identity: 'win32:1' }), 'unknown');
});

// T11 (Windows, read-only per rec#11 D-36), T13 (macOS) and the Linux
// counterpart: a real child reports its own identity, is alive (macOS:
// unknown) while it runs and exited after it ends on its own; a tampered
// identity of the same live PID is not alive.
const CHILD = `
  const { createHostIdentity } = await import(process.argv[1]);
  const me = await createHostIdentity().self();
  process.stdout.write(JSON.stringify(me) + '\\n');
  process.stdin.on('data', () => process.exit(0));
  setInterval(() => {}, 1000);`;

test('a real child process is probed read-only until it exits on its own', {
  skip: !['linux', 'darwin', 'win32'].includes(process.platform), timeout: 120_000
}, async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD,
    new URL('../src/agent-apps/host-identity.js', import.meta.url).href], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [line] = await once(child.stdout, 'data');
  const me = JSON.parse(String(line));
  assert.equal(me.pid, child.pid);
  const host = createHostIdentity();
  const live = await host.probe(me);
  const tampered = await host.probe({ pid: me.pid, identity: me.identity.replace(/\d$/, (digit) => String((Number(digit) + 1) % 10)) });
  child.stdin.write('exit\n');
  await once(child, 'exit');
  const ended = await host.probe(me);

  if (process.platform === 'darwin') {
    assert.equal(me.identity, 'darwin:unverified');
    assert.deepEqual([live, ended], ['unknown', 'exited']);
  } else {
    assert.match(me.identity, process.platform === 'win32' ? /^win32:\d+$/ : /^linux:[0-9a-f-]+:\d+:\d+$/);
    assert.deepEqual([live, tampered, ended], ['alive', 'exited', 'exited']);
  }
});

// D-28.29 static invariant: nothing in src/agent-apps sends a signal that
// stops a process, and only host-identity.js asks kill(pid, 0).
test('src/agent-apps stops no process by signal, and only host-identity.js probes with kill(pid, 0)', () => {
  const directory = join(ROOT, 'src/agent-apps');
  const files = readdirSync(directory, { recursive: true }).map(String).filter((path) => path.endsWith('.js'));
  const offenders = [];
  for (const file of files) {
    const source = readFileSync(join(directory, file), 'utf8');
    for (const [line] of source.matchAll(/^.*(?:\.kill\(|taskkill|TerminateProcess).*$/gm)) {
      const probe = /process\.kill\(pid, 0\)/.test(line) && file.replaceAll('\\', '/') === 'host-identity.js';
      if (!probe) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// D-28.26: host tools reach the data directory only through the injected port.
test('host tools never import node:fs', () => {
  const tools = join(ROOT, 'src/agent-apps/host-tools');
  for (const entry of readdirSync(tools)) {
    for (const module of reachableModules(join(tools, entry))) {
      assert.doesNotMatch(readFileSync(module, 'utf8'), /from ['"](?:node:)?fs(?:\/promises)?['"]/, module);
    }
  }
});

test('every FULI Agent tool is classified for apps, and no marked or app-managing tool is grantable', () => {
  const names = listAgentTools().map(({ name }) => name).sort();
  assert.deepEqual(Object.keys(HOST_TOOL_CATALOG).sort(), names);
  for (const [name, entry] of Object.entries(HOST_TOOL_CATALOG)) {
    if (entry.grantable) {
      assert.deepEqual(entry.marks, [], name);
      assert.ok(['read', 'write'].includes(entry.effect), name);
      assert.ok(entry.scopeFields.length > 0, name);
    }
  }
  for (const name of ['submit_agent_app_version', 'list_agent_apps', 'agent_chat', 'review_with_tonborg',
    'call_employee_tool', 'search_connected_knowledge', 'search_knowledge_graph']) {
    assert.equal(HOST_TOOL_CATALOG[name].grantable, false, name);
  }
});
