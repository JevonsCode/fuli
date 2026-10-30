import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { bundleAgentKits } from '../../scripts/agent-kits-bundle.js';
import { AGENT_KIT_PINS } from '../../src/agent-kits/pins.js';
import { readWindowsNativeBundle } from '../../src/native-runtime/windows-assets.js';
import { sha256File } from '../../src/security/digest.js';

// The Windows builds keep their downloads in a cache; the real windows-x64
// assets are cached here once per machine (any platform can verify them).
const CACHE = join(tmpdir(), 'fuli-agent-kits-test-cache');

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-agent-kit-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a Windows build refuses a downloaded component whose checksum does not match its pin', async (t) => {
  const root = directory(t);
  await assert.rejects(bundleAgentKits({ output: join(root, 'out'), cacheDir: join(root, 'cache'),
    download: async (_url, destination) => {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, 'not the release asset');
    } }), /agent-session-launcher-windows-x64\.exe failed checksum verification/);
  assert.equal(existsSync(join(root, 'out', 'runtime', 'agent-kits', 'agent-session-launcher.exe')), false);
});

test('the bundled components are recorded in native-bundle.json and the inventory', async (t) => {
  const root = directory(t);
  const output = join(root, 'out');
  let kits;
  try { kits = await bundleAgentKits({ output, cacheDir: CACHE }); } catch (error) {
    t.skip(`the pinned release assets cannot be downloaded here: ${error.message}`);
    return;
  }
  assert.deepEqual(kits.agentKits, { 'agent-session-launcher': 'runtime/agent-kits/agent-session-launcher.exe',
    'agent-installer': 'runtime/agent-kits/agent-installer.exe' });
  for (const [component, inventory] of Object.entries(kits.inventory)) {
    const pin = AGENT_KIT_PINS[component];
    assert.deepEqual(inventory, { version: pin.version, sha256: pin.sha256['windows-x64'],
      url: `https://github.com/${pin.repository}/releases/download/v${pin.version}/${component}-windows-x64.exe`,
      checksumSource: `https://github.com/${pin.repository}/releases/download/v${pin.version}/SHA256SUMS`,
      license: `src/agent-kits/vendor/${component}/LICENSE` });
    assert.equal(await sha256File(join(output, 'runtime', 'agent-kits', `${component}.exe`)), pin.sha256['windows-x64']);
    assert.equal(existsSync(new URL(`../../${inventory.license}`, import.meta.url)), true);
  }
  writeFileSync(join(output, 'native-bundle.json'), JSON.stringify({ version: 1, platform: 'win32', arch: 'x64',
    providerPackaging: 'embedded', neo4jHome: 'runtime/neo4j', javaHome: 'runtime/jre21', providerPython: 'runtime/python/python.exe',
    providerSource: 'runtime/python/Lib/site-packages', dataDir: 'data', agentKits: kits.agentKits }));
  assert.deepEqual(Object.keys(readWindowsNativeBundle(output).agentKits), ['agent-session-launcher', 'agent-installer']);
});
