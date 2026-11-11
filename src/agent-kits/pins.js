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
    version: '0.5.0',
    sha256: {
      'macos-arm64': '1c475eb13f214f96fdd6515acd2415566098fcbe6b87e1beac9393658269d74d',
      'macos-x64': '63098a46c858e3347d618f162eca519ab67aa593b29e8f0a9901f9a19d1ea405',
      'linux-x64': 'bf10041c2ff4a35eb9db6a89eab73282bbf4cac3919ffdd09aae38bd3fc4008c',
      'linux-arm64': 'e0c249c551eb6fa97078699c08bdec5bfb73162a2d7f95efd432c4b28ef4b7b5',
      'windows-x64': 'f60545bee8ea53a15fa1a5206bfe57d63484febb11868abcec662a7e47adc470'
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
