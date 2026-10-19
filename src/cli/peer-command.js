import { resolveSetupPaths } from '../setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS, readRuntimeSettings } from '../system/runtime-settings.js';
import { runPeerControlCommand } from '../../packages/roundtable/src/peer/control-cli.js';

// `fuli peer` drives the Roundtable package's peer controls on FULI's local console.
export function runPeerCommand(args, { env = process.env, fetchImpl = fetch, write = console.log } = {}) {
  const baseUrl = () => {
    const paths = resolveSetupPaths({ dataDir: option(args, '--data-dir'), env });
    const settings = paths.runtimeSettingsPath ? readRuntimeSettings(paths.runtimeSettingsPath) : DEFAULT_RUNTIME_SETTINGS;
    return `http://127.0.0.1:${settings.ports.console}`;
  };
  return runPeerControlCommand(args, { baseUrl, command: 'fuli', fetchImpl, write,
    notRunning: 'The local FULI console is not running; start it with `fuli start`.' });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
