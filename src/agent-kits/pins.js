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
    version: '0.3.1',
    sha256: {
      'macos-arm64': '0d8dfc0860bc56ad3758edee541e15ccd33d74f5e64723f76e6b5ff1da5f2f81',
      'macos-x64': 'd9d9d6e73f49807ebf9af6f2252afa256e1dd289b71ac3ca131fb40610c3fd63',
      'linux-x64': 'a908c7987b29a923bb8c64b0f59170ad8d616269cc4fa74524c88fade4b0b7f1',
      'linux-arm64': 'be39fe2a3aa0cbd8c9372da8316114c555860a5d2037f178d3383e0851d0fc43',
      'windows-x64': '9aa49744e78393c47d54330dad24c198122663fe7780087da7ed4e4df72d94c7'
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
