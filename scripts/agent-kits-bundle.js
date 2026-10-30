import { copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_KIT_COMPONENTS, AGENT_KIT_PINS, agentKitAsset } from '../src/agent-kits/pins.js';
import { downloadedExecutablePath, downloadPinnedExecutable } from '../src/agent-kits/executable-download.js';
import { sha256File } from '../src/security/digest.js';

const BUNDLE_DIRECTORY = 'runtime/agent-kits';

// The Windows portable and tray builds bundle the shared client components'
// windows-x64 executables (src/agent-kits/pins.js). Each is downloaded once
// into the build cache, verified against its pinned SHA-256 (a cached copy is
// verified again) and copied into runtime/agent-kits/. Answers the
// native-bundle.json `agentKits` entry and the inventory of what was bundled.
export async function bundleAgentKits({ output, cacheDir, download }) {
  const agentKits = {};
  const inventory = {};
  await mkdir(join(output, ...BUNDLE_DIRECTORY.split('/')), { recursive: true });
  for (const component of AGENT_KIT_COMPONENTS) {
    const asset = agentKitAsset(component, 'win32', 'x64');
    let cached = downloadedExecutablePath(cacheDir, asset);
    if (!existsSync(cached) || await sha256File(cached) !== asset.sha256) {
      await rm(cached, { force: true });
      cached = await downloadPinnedExecutable(cacheDir, asset, download ? { download } : {});
    }
    const bundled = `${BUNDLE_DIRECTORY}/${component}.exe`;
    await copyFile(cached, join(output, ...bundled.split('/')));
    agentKits[component] = bundled;
    inventory[component] = { version: asset.version, url: asset.url, sha256: asset.sha256,
      checksumSource: `https://github.com/${AGENT_KIT_PINS[component].repository}/releases/download/v${asset.version}/SHA256SUMS`,
      license: `src/agent-kits/vendor/${component}/LICENSE` };
  }
  return { agentKits, inventory };
}
