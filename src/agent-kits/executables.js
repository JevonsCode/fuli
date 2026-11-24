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
// pinned asset when nothing else is there, or when the copy there no longer
// matches its pin. Either answers { status: 'available', path, source } or
// { status: 'unavailable', reason }; a caller that gets 'unavailable' keeps
// FULI's own behaviour.
//
// While another FULI process downloads the same component, `ensure` waits
// for it and reports that once through onWait({ component, message }); with
// waitForOthers false it answers at once with { status: 'unavailable',
// reason, downloading: true } instead (the console, which reads again soon).
// ensure(component, { signal }): the caller's abort ends its own wait with
// { status: 'unavailable', reason, cancelled: true }; the download itself
// stops once every caller waiting for it has aborted.
//
// bundleRoot: the Windows portable or tray bundle FULI runs from
// (paths.portableRoot), or null for an npm installation.
export function agentKitExecutables({
  nativeRuntimeDir,
  bundleRoot = null,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  download = downloadPinnedExecutable,
  onWait = () => {},
  waitForOthers = true
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

  async function ensure(component, { signal } = {}) {
    const found = await resolve(component);
    const asset = agentKitAsset(component, platform, arch);
    // An override names the only copy to use.
    if (found.status === 'available' || env[AGENT_KIT_OVERRIDE_ENV[component]] || !asset) return found;
    const flight = inFlight.get(component);
    return follow(flight && !flight.controller.signal.aborted ? flight : start(component, asset), component, signal);
  }

  // One download per component in this process, shared by every caller.
  function start(component, asset) {
    const controller = new AbortController();
    const flight = { callers: 0, controller };
    flight.result = download(nativeRuntimeDir, asset, { signal: controller.signal, waitForOthers,
      onWait: () => onWait({ component, message: waitingForDownloadMessage(component) }) })
      .then((path) => available(path, 'download'))
      .catch((error) => (error?.code === 'other_download' ? { ...unavailable(otherDownloadMessage(component)), downloading: true }
        : controller.signal.aborted ? cancelled(component)
          : unavailable(`${component} could not be downloaded: ${error.message}`)))
      .finally(() => { if (inFlight.get(component) === flight) inFlight.delete(component); });
    inFlight.set(component, flight);
    return flight;
  }

  function follow(flight, component, signal) {
    flight.callers += 1;
    if (!signal) return flight.result;
    const leave = () => { flight.callers -= 1; if (flight.callers === 0) flight.controller.abort(); };
    if (signal.aborted) { leave(); return Promise.resolve(cancelled(component)); }
    return new Promise((done) => {
      const abort = () => { leave(); done(cancelled(component)); };
      signal.addEventListener('abort', abort, { once: true });
      flight.result.then((answer) => { signal.removeEventListener('abort', abort); done(answer); });
    });
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
const cancelled = (component) => ({ ...unavailable(`Waiting for ${component} was cancelled.`), cancelled: true });

// What a person reads while another FULI downloads a component this one needs.
export function otherDownloadMessage(component) {
  return `另一个 FULI 正在下载客户端组件 ${component}，等它完成。`
    + ` Another FULI is downloading the client component ${component}; waiting for it to finish.`;
}

// What a waiting CLI prints: roughly how long (a download that hangs is taken over after 11 minutes,
// executable-download.js), and how to stop waiting.
function waitingForDownloadMessage(component) {
  return `另一个 FULI 正在下载客户端组件 ${component}，等它完成：通常一两分钟，最长约 11 分钟；按 Ctrl+C 可取消等待。`
    + ` Another FULI is downloading the client component ${component}; waiting for it to finish, usually a minute or two`
    + ' and at most about 11 minutes. Press Ctrl+C to stop waiting.';
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}
