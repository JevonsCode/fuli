import { deepFreeze } from '../validation/values.js';

// The two shared client components FULI runs as native executables (rec#11
// D-79): one pinned release each, with the SHA-256 of every platform's asset
// copied from that release's SHA256SUMS. This is the only place the versions,
// download URLs and checksums live; the Windows bundle build and the runtime
// download both read it. How to bump: docs/client-connections.md, "Shared
// client components".
export const AGENT_KIT_PINS = deepFreeze({
  'agent-session-launcher': {
    repository: 'JevonsCode/agent-session-launcher',
    version: '0.5.1',
    sha256: {
      'macos-arm64': '22212ebaecb0f19246eb1bd74ea41bdbc8a41f4ca7e0d8eabebd625cf6905fa9',
      'macos-x64': 'af1dd697cebf3e4f6791d5db3ea9b6050e74bcbc6ecd7604489db5fbaecb1499',
      'linux-x64': '8701c769a15d9b66ff2da14265a66565658d834a75c34443667528a35b716ceb',
      'linux-arm64': 'de287bcd96b71a257aa084852b601be580bfab4adc3b57c8c026644f4ffbac5a',
      'windows-x64': '05a5c13bac42fe7d26acdf160e7d65cc6dbc0886008dcd4d35f112eeb3abcc52'
    }
  },
  'agent-installer': {
    repository: 'JevonsCode/agent-installer',
    version: '0.4.1',
    sha256: {
      'macos-arm64': 'c54f2591b02bcad837afc6c7fdfa547e6c0035288606ba5d4516f4f55ccb4109',
      'macos-x64': 'ebcbe53ddb5a07c06d3d7de4d546d19431b7a373dc651d341cc1f0dd49dd4b79',
      'linux-x64': '53c6c31af4bed04108694dfc64d0eb2ee64ddfe0de32ca783712251c0942c418',
      'linux-arm64': '185e1e9345d356d865010b24494df702a81f7ed753c14c53a8f96d89f932792b',
      'windows-x64': '51bbb9a3a0eab8d9b47eaa7979ee07d133388cae1290da8dbc50af36bf816567'
    }
  }
});

export const AGENT_KIT_COMPONENTS = Object.freeze(Object.keys(AGENT_KIT_PINS));

const OPERATING_SYSTEMS = Object.freeze({ darwin: 'macos', linux: 'linux', win32: 'windows' });

// The pinned release asset of `component` for this platform, or null when the
// component publishes none for it (for example Windows on arm64).
export function agentKitAsset(component, platform = process.platform, arch = process.arch) {
  const pin = AGENT_KIT_PINS[component];
  if (!pin) throw new TypeError(`Unknown agent kit component: ${component}`);
  const target = `${OPERATING_SYSTEMS[platform]}-${arch}`;
  const sha256 = pin.sha256[target];
  if (!sha256) return null;
  const name = `${component}-${target}${platform === 'win32' ? '.exe' : ''}`;
  return { component, version: pin.version, target, name, sha256,
    url: `https://github.com/${pin.repository}/releases/download/v${pin.version}/${name}` };
}
