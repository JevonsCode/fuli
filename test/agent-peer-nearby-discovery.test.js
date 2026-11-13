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

test('one advertisement and one browse per adapter, stopped and refreshed together', async () => {
  // Two endpoints on loopback ports nothing else uses: no packet leaves this computer.
  const discovery = createBonjourDiscovery({ adapters: () => ['127.0.0.1', '127.0.0.1'] });
  const advert = discovery.advertise({ name: 'FULI 0a0b0c0d', host: 'fuli-0a0b0c0d.local', port: 4100, txt: { v: '1' }, addresses: ['192.168.1.8'] });
  const browser = discovery.browse({ onUp: () => {}, onDown: () => {} });
  browser.refresh();
  browser.stop();
  advert.stop();
  discovery.close();
  discovery.close();
});
