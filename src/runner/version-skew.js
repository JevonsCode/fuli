import { liveMcpProcesses } from '../mcp/process-registry.js';
import { FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions } from '../semantic-version.js';

// A runner and its host run their own copies of FULI (docs/runner.md), and
// nothing keeps them on the same version: a runner left in an office stays on
// the version it joined with (rec#144). FULI says which side is older and
// leaves the call alone — a runner and host that understand each other keep
// working, and nothing here refuses anything.
//
// Answers { older: 'host' | 'runner', hostVersion, runnerVersion } or null
// when the versions match or either side's version cannot be read.
export function versionSkew({ hostVersion, runnerVersion }) {
  if (typeof hostVersion !== 'string' || typeof runnerVersion !== 'string') return null;
  let order;
  try {
    order = compareSemanticVersions(hostVersion.replace(/^v/, ''), runnerVersion.replace(/^v/, ''));
  } catch {
    // One side names something that is not a version: FULI says nothing rather than guess which is older.
    return null;
  }
  // Equal precedence is the same release, however it is spelled (a `v`, build metadata).
  if (order === 0) return null;
  return { older: order < 0 ? 'host' : 'runner', hostVersion, runnerVersion };
}

// The one skew between the host and this runner, whatever runs here: the
// runner is behind when any copy running here is older than the host (the
// copy to update or restart), otherwise the host when it is older than them.
// runnerVersions: runningRunnerVersions(). The one rule `fuli status`,
// `fuli runner status` and the runner's 客户端接入 page all use.
export function runnerVersionSkew({ hostVersion, runnerVersions }) {
  const skews = runnerVersions.map((runnerVersion) => versionSkew({ hostVersion, runnerVersion })).filter(Boolean);
  return skews.find(({ older }) => older === 'runner') ?? skews.find(({ older }) => older === 'host') ?? null;
}

// The one line `fuli status` and `fuli runner status` print for it.
// hostName: what this runner calls its host.
export function versionSkewLine(skew, hostName) {
  const host = hostName ?? 'the host';
  return skew.older === 'runner'
    ? `FULI versions differ: this runner runs ${skew.runnerVersion}, ${host} runs ${skew.hostVersion}. `
      + 'This computer is older; update it (npm install --global fuli-context). Calls both versions understand keep working.'
    : `FULI versions differ: this runner runs ${skew.runnerVersion}, ${host} runs ${skew.hostVersion}. `
      + `${host} is older; update FULI there. Calls both versions understand keep working.`;
}

// The FULI versions that talk to the host from this runner: those its open
// client sessions' MCP servers run (process-registry.js), which stay on the
// version they started with until restarted, or, with none open, the one
// installed here. live: liveMcpProcesses, replaceable in tests.
export function runningRunnerVersions(runtimeConfigPath, { live = liveMcpProcesses, installed = FULI_VERSION } = {}) {
  const versions = [...new Set(live(runtimeConfigPath).map(({ version }) => version).filter(Boolean))];
  return versions.length ? versions.sort(bySemanticVersion) : [installed];
}

// Oldest first by version precedence (0.9 before 0.10); a name that is not a version goes last.
function bySemanticVersion(left, right) {
  try {
    return compareSemanticVersions(left.replace(/^v/, ''), right.replace(/^v/, ''));
  } catch {
    return String(left).localeCompare(String(right));
  }
}
