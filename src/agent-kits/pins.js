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
    version: '0.2.0',
    sha256: {
      'macos-arm64': '1ca3cde9273cab05515963308f8c348a768dd2b40b928262f026c514971d492a',
      'macos-x64': 'a8ffdbcbe47c313d5c275e1daad8be62b43ca4a22ce4c11c805ca53d19cddb29',
      'linux-x64': 'dcd27bbc71081b0a64200591b7795b28cef552ebe4340d0b83eb1d12b2038617',
      'linux-arm64': '460fdb9b525a1cbb51aaf6d789f637bacc3c0db006c15eaf786f6d7804fbac90',
      'windows-x64': 'dea9f4e26ef5d7604edc7420ae33436ee5c82064f17c967dd095b110b6648e64'
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
