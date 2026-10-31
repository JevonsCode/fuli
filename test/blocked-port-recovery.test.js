import assert from 'node:assert/strict';
import test from 'node:test';

import { portMoveSentence, recoverBlockedPorts } from '../src/system/blocked-port-recovery.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

// Synthetic reserved ranges and listen probes only: no netsh, no real port.

const SETTINGS = Object.freeze({ ...DEFAULT_RUNTIME_SETTINGS, ports: { ...DEFAULT_RUNTIME_SETTINGS.ports, console: 2828 } });
const noFuliConsole = async () => false;

function recover(settings, { ranges = [], refusals = {}, probed = [], ...options } = {}) {
  return recoverBlockedPorts(settings, {
    fuliConsoleAt: noFuliConsole,
    platform: 'win32',
    readRanges: ({ platform }) => { assert.equal(platform, 'win32'); return ranges; },
    probe: async (port, host) => { probed.push([port, host]); return refusals[port] ?? null; },
    ...options
  });
}

test('ports that can be used stay as they are, and only the console is probed', async () => {
  const probed = [];
  const result = await recover(SETTINGS, { probed });
  assert.deepEqual(result, { settings: SETTINGS, moves: [] });
  assert.deepEqual(probed, [[2828, '127.0.0.1']]);
});

test('the replacement is the nearest usable port to the saved one, the same on every start', async () => {
  const ranges = [{ start: 2800, end: 2830 }];
  const first = await recover(SETTINGS, { ranges });
  const again = await recover(SETTINGS, { ranges });
  assert.deepEqual(first.moves, [{ key: 'console', from: 2828, to: 2831, reason: 'reserved' }]);
  assert.deepEqual(again, first);
  assert.equal(first.settings.ports.console, 2831);
  assert.equal(first.settings.lanAccess, SETTINGS.lanAccess, 'nothing else changes');
});

test('Windows refusing the console port outside any listed range still moves it', async () => {
  const result = await recover(SETTINGS, { refusals: { 2828: 'EACCES', 2829: 'EACCES' } });
  assert.deepEqual(result.moves, [{ key: 'console', from: 2828, to: 2827, reason: 'refused' }]);
});

test('a refusal another port cannot fix is left to the start to report', async () => {
  const result = await recover(SETTINGS, { refusals: { 2828: 'EADDRNOTAVAIL' } });
  assert.deepEqual(result.moves, []);
});

test('a LAN console is probed on every interface it will listen on; the services on loopback', async () => {
  const probed = [];
  const lan = { ...SETTINGS, lanAccess: true, ports: { ...SETTINGS.ports, personalProvider: 8787 } };
  await recover(lan, { ranges: [{ start: 8787, end: 8787 }], probed });
  assert.deepEqual(probed, [[2828, '0.0.0.0'], [8786, '127.0.0.1']], '8788 above is the shared-project Provider');
});

test('a service port that is merely busy is kept: its own runtime may be holding it', async () => {
  const probed = [];
  const result = await recover(SETTINGS, { refusals: { 7687: 'EADDRINUSE' }, probed });
  assert.deepEqual(result.moves, []);
  assert.equal(probed.some(([port]) => port === 7687), false);
});

test('a moved port never lands on another FULI port, old or new', async () => {
  const settings = { ...SETTINGS, ports: { ...SETTINGS.ports, console: 8786 } };
  const result = await recover(settings, { ranges: [{ start: 8786, end: 8786 }], refusals: { 8785: 'EADDRINUSE' } });
  assert.deepEqual(result.moves, [{ key: 'console', from: 8786, to: 8784, reason: 'reserved' }],
    '8787 and 8788 are the Providers, 8785 is busy');
});

test('the recorded console of this data directory is not probed and keeps its port', async () => {
  const probed = [];
  const result = await recover(SETTINGS, { recordedConsolePort: 2828, refusals: { 2828: 'EADDRINUSE' }, probed });
  assert.deepEqual(result.moves, []);
  assert.deepEqual(probed, []);
});

test('a FULI console FULI cannot place is never moved away from or joined', async () => {
  const asked = [];
  await assert.rejects(recover(SETTINGS, {
    refusals: { 2828: 'EADDRINUSE' },
    fuliConsoleAt: async (port) => { asked.push(port); return true; }
  }), /Another FULI is already running on port 2828/);
  assert.deepEqual(asked, [2828]);
});

test('without a usable port nearby the start fails instead of picking a random one', async () => {
  await assert.rejects(recover(SETTINGS, { ranges: [{ start: 1024, end: 65_535 }] }), /No usable port was found near 2828/);
});

test('each move is one plain sentence naming the cause, the service and the saved port', () => {
  assert.equal(portMoveSentence({ key: 'console', from: 2727, to: 2734, reason: 'reserved' }),
    'Port 2727 is reserved by Windows, so the management UI now uses port 2734. The new port is saved.');
  assert.equal(portMoveSentence({ key: 'personalProvider', from: 8787, to: 8789, reason: 'in_use' }),
    'Another program uses port 8787, so the personal graph Provider now uses port 8789. The new port is saved.');
  assert.equal(portMoveSentence({ key: 'workspaceNeo4jBolt', from: 7688, to: 7689, reason: 'refused' }),
    'Windows refused port 7688, so the shared-project Neo4j Bolt endpoint now uses port 7689. The new port is saved.');
});
