import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import test from 'node:test';

import { cleanName } from '../packages/roundtable/src/peer/coordinator-service.js';
import { announcedAddresses, lanAddresses } from '../packages/roundtable/src/peer/lan-addresses.js';
import { createBonjourDiscovery } from '../packages/roundtable/src/peer/nearby-discovery.js';
import { createNearbyPresence } from '../packages/roundtable/src/peer/nearby-presence.js';

const interfaces = () => ({
  'vEthernet (WSL)': [{ address: '172.29.112.1', family: 'IPv4', internal: false }],
  Ethernet: [{ address: '192.168.1.8', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  utun3: [{ address: '100.64.0.2', family: 'IPv4', internal: false }],
});

test('security review: a multicast socket that cannot bind turns into a reported failure, not a crash', async () => {
  // The reviewer's probe on loopback: a port another socket holds exclusively.
  const holder = createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve) => holder.bind({ port: 0, address: '127.0.0.1', exclusive: true }, resolve));
  try {
    const failure = Promise.withResolvers();
    const discovery = createBonjourDiscovery({ onFailure: failure.resolve,
      options: { port: holder.address().port, interface: '127.0.0.1', reuseAddr: false, multicast: false } });
    const browser = discovery.browse({ onUp: () => {}, onDown: () => {} });
    const error = await failure.promise;
    assert.match(error.code, /EADDRINUSE|EACCES/);
    // Everything after the failure is a no-op, never a throw.
    browser.refresh();
    browser.stop();
    discovery.close();
  } finally { holder.close(); }
});

test('third review: names from other devices lose invisible characters and are cut between whole characters', () => {
  const c = (...codes) => String.fromCodePoint(...codes);
  const samples = [
    [`Al${c(0x200b)}ice`, 'Alice'], [`Desk${c(0x2028)}Paired`, 'DeskPaired'], [`A${c(0x2068)}B`, 'AB'], [`${c(0xfeff)}Desk`, 'Desk'],
    [`Desk${c(0xe0041)}`, 'Desk'], [`${c(0x3164)}${c(0x3164)}`, ''], [`${c(0x1b)}[31mred`, '[31mred'],
    ['x'.repeat(59) + c(0x1f600), 'x'.repeat(59) + c(0x1f600)], ['x'.repeat(60) + c(0x1f600), 'x'.repeat(60)],
    // A joiner is invisible too, so a joined emoji becomes its parts, cut between them.
    ['x'.repeat(59) + c(0x1f468, 0x200d, 0x1f469), 'x'.repeat(59) + c(0x1f468)],
    ['x'.repeat(59) + c(0x65, 0x301, 0x65), 'x'.repeat(59) + c(0x65, 0x301)],
  ];
  for (const [value, expected] of samples) assert.equal(cleanName(value), expected, JSON.stringify(value));
});

test('only physical LAN addresses are announced and offered first', () => {
  assert.deepEqual(announcedAddresses(interfaces), ['192.168.1.8']);
  assert.deepEqual(lanAddresses(interfaces), ['192.168.1.8', '172.29.112.1', '100.64.0.2']);
  assert.deepEqual(announcedAddresses(() => ({ 'vEthernet (WSL)': interfaces()['vEthernet (WSL)'] })), ['172.29.112.1']);
});

test('the nearby list is capped, forgets computers that stopped answering, and advertises a fresh id each time', () => {
  let now = 0;
  const adverts = [];
  let handlers = null;
  const discovery = { browse: (next) => { handlers = next; return { stop() {}, refresh() {} }; },
    advertise: (record) => { adverts.push(record); return { stop() {} }; }, close() {} };
  const presence = createNearbyPresence({ discovery, clock: () => now });
  presence.browse('0'.repeat(64));
  for (let index = 0; index < 40; index += 1) {
    handlers.onUp({ port: 4100, addresses: ['192.168.1.20'], txt: { v: '1', fp: index.toString(16).padStart(16, 'a'), n: `Device ${index}` } });
  }
  assert.equal(presence.list().length, 32);
  assert.equal(presence.list()[0].name, 'Device 8', 'the least recently seen go first');
  now = 100_000;
  handlers.onUp({ port: 4100, addresses: ['192.168.1.20'], txt: { v: '1', fp: 'b'.repeat(16), n: 'Laptop' } });
  now = 160_000;
  assert.deepEqual(presence.list().map((entry) => entry.name), ['Laptop']);
  handlers.onUp({ port: 4100, addresses: ['192.168.1.20'], txt: { v: '2', fp: 'c'.repeat(16), n: 'Other version' } });
  assert.equal(presence.list().length, 1, 'another protocol version is ignored');
  // second review: a name another device sends never carries terminal escapes or direction overrides.
  handlers.onUp({ port: 4100, addresses: ['192.168.1.21'], txt: { v: '1', fp: 'd'.repeat(16), n: '\u001b[2JLap\u202etop\u0085' } });
  assert.equal(presence.list().find((entry) => entry.fingerprint === 'd'.repeat(16)).name, '[2JLaptop');

  presence.advertise({ name: 'Desk', port: 4100, fingerprint: '1'.repeat(64), addresses: ['192.168.1.8'] });
  presence.stop();
  presence.advertise({ name: 'Desk', port: 4100, fingerprint: '1'.repeat(64), addresses: ['192.168.1.8'] });
  assert.match(adverts[0].name, /^FULI [0-9a-f]{8}$/);
  assert.notEqual(adverts[0].name, adverts[1].name);
  assert.deepEqual([adverts[0].txt, adverts[0].addresses], [{ v: '1', fp: '1'.repeat(16), n: 'Desk' }, ['192.168.1.8']]);
});

test('nearby discovery uses one address of each physical adapter, never a VPN or virtual one', async () => {
  const { discoveryAdapters } = await import('../packages/roundtable/src/peer/lan-addresses.js');
  // A VPN listed first with the best metric is what the system would send from.
  const machine = () => ({
    Tailscale: [{ address: '100.64.0.9', family: 'IPv4', internal: false }],
    Ethernet: [{ address: '192.168.1.8', family: 'IPv4', internal: false }, { address: '192.168.1.9', family: 'IPv4', internal: false }],
    'Wi-Fi': [{ address: '169.254.7.2', family: 'IPv4', internal: false }],
    en1: [{ address: 'fe80::2', family: 'IPv6', internal: false }, { address: '10.0.0.4', family: 'IPv4', internal: false }],
    'vEthernet (WSL)': [{ address: '172.29.112.1', family: 'IPv4', internal: false }],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  });
  assert.deepEqual(discoveryAdapters(machine), ['192.168.1.8', '10.0.0.4']);
  assert.deepEqual(discoveryAdapters(() => ({ Tailscale: machine().Tailscale })), [], 'no physical adapter: the system default is used');
});

// A stand-in for the mDNS library: it records what each endpoint was asked to do.
function fakeEndpoints() {
  const made = [];
  const create = (target) => {
    const handlers = {};
    const endpoint = { target, published: [], finds: 0, stopped: 0, destroyed: false, fail: (error) => handlers.error?.(error),
      server: { mdns: { on: (event, handler) => { handlers[event] = handler; } } },
      publish: (config) => { const service = { config, records: () => [{ type: 'A', data: '192.168.1.8' }, { type: 'A', data: '100.64.0.9' }],
        stop: () => { service.stopped = true; }, on() {} }; endpoint.published.push(service); return service; },
      find: () => { endpoint.finds += 1; return { on() {}, stop: () => { endpoint.stopped += 1; } }; },
      destroy: () => { endpoint.destroyed = true; } };
    made.push(endpoint);
    return endpoint;
  };
  return { made, create };
}

test('review: each adapter gets its own endpoint that binds every address, with its own name and only the announced addresses', () => {
  const { made, create } = fakeEndpoints();
  const discovery = createBonjourDiscovery({ adapters: () => ['192.168.1.8', '10.0.0.4'], create });
  const advert = discovery.advertise({ name: 'FULI 0a0b0c0d', host: 'fuli-0a0b0c0d.local', port: 4100, txt: { v: '1' }, addresses: ['192.168.1.8'] });
  // macOS and Linux deliver multicast only to a socket bound to every address.
  assert.deepEqual(made.map((endpoint) => endpoint.target), [{ interface: '192.168.1.8', bind: '0.0.0.0' }, { interface: '10.0.0.4', bind: '0.0.0.0' }]);
  assert.deepEqual(made.map((endpoint) => endpoint.published[0].config.name), ['FULI 0a0b0c0d', 'FULI 0a0b0c0d-2']);
  assert.deepEqual(made.map((endpoint) => endpoint.published[0].config.host), ['fuli-0a0b0c0d.local', 'fuli-0a0b0c0d-2.local']);
  assert.deepEqual(made[1].published[0].records().map((record) => record.data), ['192.168.1.8']);
  advert.stop();
  assert.ok(made.every((endpoint) => endpoint.published[0].stopped));
  discovery.close();
  assert.ok(made.every((endpoint) => endpoint.destroyed));
  // No physical adapter: one endpoint on the system default, as before.
  const fallback = fakeEndpoints();
  createBonjourDiscovery({ adapters: () => [], create: fallback.create }).browse({ onUp() {}, onDown() {} });
  assert.deepEqual(fallback.made.map((endpoint) => endpoint.target), [undefined]);
});

test('review: a refresh on a changed network starts over and announces again; an unchanged one only asks again', () => {
  const { made, create } = fakeEndpoints();
  let addresses = ['192.168.1.8'];
  const discovery = createBonjourDiscovery({ adapters: () => addresses, create });
  discovery.advertise({ name: 'FULI 0a0b0c0d', host: 'fuli-0a0b0c0d.local', port: 4100, txt: { v: '1' } });
  const browser = discovery.browse({ onUp() {}, onDown() {} });
  browser.refresh();
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].finds, made[0].stopped, made[0].published.length], [2, 1, 1]);
  addresses = ['192.168.7.20'];
  browser.refresh();
  assert.equal(made[0].destroyed, true);
  assert.deepEqual(made[1].target, { interface: '192.168.7.20', bind: '0.0.0.0' });
  assert.deepEqual([made[1].finds, made[1].published.length], [1, 1]);
  discovery.close();
});

test('review: one adapter failing leaves the others working; the failure is reported once, when none is left', () => {
  const { made, create } = fakeEndpoints();
  const failures = [];
  const discovery = createBonjourDiscovery({ adapters: () => ['192.168.1.8', '10.0.0.4'], create, onFailure: (error) => failures.push(error.code) });
  const browser = discovery.browse({ onUp() {}, onDown() {} });
  made[0].fail(Object.assign(new Error('gone'), { code: 'EADDRNOTAVAIL' }));
  assert.deepEqual([made[0].destroyed, made[1].destroyed, failures.length], [true, false, 0]);
  browser.refresh();
  assert.equal(made[1].finds, 2, 'the adapter that still works keeps asking');
  made[1].fail(Object.assign(new Error('taken'), { code: 'EADDRINUSE' }));
  made[1].fail(Object.assign(new Error('again'), { code: 'EADDRINUSE' }));
  assert.deepEqual(failures, ['EADDRINUSE']);
  discovery.close();
});
