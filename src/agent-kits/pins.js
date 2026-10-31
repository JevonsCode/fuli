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
    version: '0.4.0',
    sha256: {
      'macos-arm64': '9c65ed2ba10378250bf86af8f5b8874984f97cfe68018750c689cbede964ff99',
      'macos-x64': 'a50379638576d1607934aff8c50f633c49a216de90cf74a0801cd414d376460b',
      'linux-x64': '22918a7bbca1a09d16b2ed711195d6408995c998298a91427e5e6ddb0fd4948d',
      'linux-arm64': '68ee8887034eba7d3e6f348baed14130650474f63739c319a3eba9cb52afdeb9',
      'windows-x64': '1b1acddacb5bbaded1a8e13886e7a6becb62384d746a40fe1046b1562621e647'
    }
  },
  'agent-installer': {
    repository: 'JevonsCode/agent-installer',
    version: '0.2.1',
    sha256: {
      'macos-arm64': '25a560a95c80e7729cd462ffd767877f1d1703cc3428c424ca1e6daafc2625e8',
      'macos-x64': 'e00c45ea69a54ec7abd0928840099acfd8b55c23d28c7620361c0e02c38da350',
      'linux-x64': '3b1c8e31100d74cc83d0f6e7edc8ed389ab62f6b0ade1c85596cd8ae47bffe65',
      'linux-arm64': '964047fa228ec225972730410c96ab28c1c97041a7703ab8717b2e8fffca8861',
      'windows-x64': 'd9516dcb313143b55e582781477890158005a7121c5a7a671f36533144df6573'
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
