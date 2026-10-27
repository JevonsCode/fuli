import assert from 'node:assert/strict';
import test from 'node:test';

import {
  firstOpenPortNear,
  readReservedPortRanges,
  reservedPortProblem,
  withoutReservedPorts
} from '../src/system/reserved-ports.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

// Synthetic `netsh interface ipv4 show excludedportrange protocol=tcp` output.
const ENGLISH_NETSH = `
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
      2634        2733
      5357        5357
     50000       50059     *

* - Administered port exclusions.
`;
const CHINESE_NETSH = `
协议 tcp 端口排除范围

开始端口    结束端口
----------    --------
      2634        2733
      7600        7699

* - 管理的端口排除。
`;
const RESERVED = Object.freeze([{ start: 2634, end: 2733 }, { start: 7600, end: 7699 }]);
const neverProbed = async () => { throw new Error('the port must not be probed'); };

test('reserved ranges are read from netsh rows whatever language its headers use', () => {
  assert.deepEqual(readReservedPortRanges({ platform: 'win32', runNetsh: () => ENGLISH_NETSH }), [
    { start: 2634, end: 2733 }, { start: 5357, end: 5357 }, { start: 50000, end: 50059 }
  ]);
  assert.deepEqual(readReservedPortRanges({ platform: 'win32', runNetsh: () => CHINESE_NETSH }), RESERVED);
  assert.deepEqual(readReservedPortRanges({ platform: 'win32', runNetsh: () => '      3000   2000\n  1 70000\n' }), [],
    'reversed or out-of-range rows are not ranges');
});

test('reserved ranges are Windows only, and an unreadable table means none are known', () => {
  assert.deepEqual(readReservedPortRanges({ platform: 'darwin', runNetsh: () => { throw new Error('netsh must not run'); } }), []);
  assert.deepEqual(readReservedPortRanges({ platform: 'win32', runNetsh: () => { throw new Error('netsh missing'); } }), []);
});

test('a reserved console port is explained with the real range, in Chinese and English', async () => {
  const problem = await reservedPortProblem(2727, { platform: 'win32', readRanges: () => RESERVED, probe: neverProbed });
  assert.match(problem, /端口 2727 被 Windows 保留（2634–2733），换一个端口即可/);
  assert.match(problem, /Port 2727 is reserved by Windows \(2634–2733\); use another port/);
});

test('EACCES outside a known range is still named as a Windows refusal; other causes are not', async () => {
  const outside = { platform: 'win32', readRanges: () => RESERVED };
  assert.match(await reservedPortProblem(3100, { ...outside, probe: async () => 'EACCES' }), /Windows 拒绝 FULI 使用端口 3100/);
  assert.equal(await reservedPortProblem(3100, { ...outside, probe: async () => 'EADDRINUSE' }), null);
  assert.equal(await reservedPortProblem(3100, { ...outside, probe: async () => null }), null);
});

test('other systems keep their behavior: no netsh and no probe', async () => {
  assert.equal(await reservedPortProblem(2727, { platform: 'linux',
    readRanges: () => { throw new Error('ranges must not be read'); }, probe: neverProbed }), null);
});

test('only reserved FULI ports move, each to the nearest port outside every range', () => {
  const ports = withoutReservedPorts(DEFAULT_RUNTIME_SETTINGS.ports, RESERVED);
  assert.deepEqual(ports, { ...DEFAULT_RUNTIME_SETTINGS.ports, console: 2734,
    personalNeo4jBolt: 7700, workspaceNeo4jBolt: 7701 });
  assert.deepEqual(withoutReservedPorts(DEFAULT_RUNTIME_SETTINGS.ports, []), DEFAULT_RUNTIME_SETTINGS.ports);
});

test('a moved port never lands on another FULI port', () => {
  const ports = withoutReservedPorts({ ...DEFAULT_RUNTIME_SETTINGS.ports, personalProvider: 2734 }, RESERVED);
  assert.equal(ports.console, 2735);
  assert.equal(new Set(Object.values(ports)).size, Object.keys(ports).length);
});

test('the open port nearest the preferred one skips reserved, taken and busy ports', async () => {
  const probed = [];
  const port = await firstOpenPortNear(2727, {
    ranges: RESERVED, taken: new Set([2734]), host: '127.0.0.1',
    probe: async (candidate, host) => {
      probed.push([candidate, host]);
      return candidate === 2735 ? 'EADDRINUSE' : null;
    }
  });
  assert.equal(port, 2736);
  assert.deepEqual(probed, [[2735, '127.0.0.1'], [2736, '127.0.0.1']]);
});

test('no open port near the preferred one is an error, not a silent default', async () => {
  await assert.rejects(firstOpenPortNear(2727, { ranges: [], taken: new Set(), host: '127.0.0.1', probe: async () => 'EACCES' }),
    /No usable port was found near 2727/);
});
