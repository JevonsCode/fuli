import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { readWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { sha256File } from '../security/digest.js';
import { agentKitAsset } from './pins.js';
import { downloadedExecutablePath, downloadPinnedExecutable } from './executable-download.js';

// A developer's own build of a component, used instead of every pinned copy.
const AGENT_KIT_OVERRIDE_ENV = Object.freeze({
  'agent-session-launcher': 'FULI_AGENT_SESSION_LAUNCHER',
  'agent-installer': 'FULI_AGENT_INSTALLER'
});

// Where FULI finds a shared client component's executable, in this order:
// the developer override, the Windows bundle's copy, a verified download in
// the data directory. `resolve` never downloads; `ensure` downloads the
// pinned asset when nothing else is there. Either answers
// { status: 'available', path, source } or { status: 'unavailable', reason };
// a caller that gets 'unavailable' keeps FULI's own behaviour.
//
// bundleRoot: the Windows portable or tray bundle FULI runs from
// (paths.portableRoot), or null for an npm installation.
export function agentKitExecutables({
  nativeRuntimeDir,
  bundleRoot = null,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  download = downloadPinnedExecutable
}) {
  const inFlight = new Map();
  const verified = new Map();

  async function resolve(component) {
    const override = env[AGENT_KIT_OVERRIDE_ENV[component]];
    if (override) {
      return isAbsolute(override) && isFile(override)
        ? available(override, 'override')
        : unavailable(`${AGENT_KIT_OVERRIDE_ENV[component]} does not name an executable file.`);
    }
    const bundled = platform === 'win32' && bundleRoot ? bundledExecutable(component) : null;
    if (bundled && isFile(bundled)) return available(bundled, 'bundle');
    const asset = agentKitAsset(component, platform, arch);
    if (!asset) return unavailable(`${component} is not published for ${platform} ${arch}.`);
    const path = downloadedExecutablePath(nativeRuntimeDir, asset);
    if (!isFile(path)) return unavailable(`${component} ${asset.version} has not been downloaded yet.`);
    return await matchesPin(path, asset) ? available(path, 'download')
      : unavailable(`The downloaded ${component} does not match its pinned checksum.`);
  }

  async function ensure(component) {
    const found = await resolve(component);
    const asset = agentKitAsset(component, platform, arch);
    // An override names the only copy to use; a present download failed its pin.
    if (found.status === 'available' || env[AGENT_KIT_OVERRIDE_ENV[component]] || !asset
        || isFile(downloadedExecutablePath(nativeRuntimeDir, asset))) return found;
    if (!inFlight.has(component)) {
      inFlight.set(component, download(nativeRuntimeDir, asset)
        .then((path) => available(path, 'download'))
        .catch((error) => unavailable(`${component} could not be downloaded: ${error.message}`))
        .finally(() => inFlight.delete(component)));
    }
    return inFlight.get(component);
  }

  function bundledExecutable(component) {
    try { return readWindowsNativeBundle(bundleRoot)?.agentKits?.[component] ?? null; } catch { return null; }
  }

  // Hashed once per file version in this process: a replaced file is checked again.
  async function matchesPin(path, asset) {
    const { size, mtimeMs } = statSync(path);
    const key = `${path}\0${size}\0${mtimeMs}`;
    if (!verified.has(key)) verified.set(key, await sha256File(path) === asset.sha256);
    return verified.get(key);
  }

  return { resolve, ensure };
}

const available = (path, source) => ({ status: 'available', path, source });
const unavailable = (reason) => ({ status: 'unavailable', reason });

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}
