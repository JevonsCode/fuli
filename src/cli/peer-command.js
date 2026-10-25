import { SIGN_IN_TOKEN_HEADER } from '../console-session/http.js';
import { humanReviewToken } from '../graphiti/human-review-channel.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS, readRuntimeSettings } from '../system/runtime-settings.js';
import { runPeerControlCommand } from '../../packages/roundtable/src/peer/control-cli.js';

// `fuli peer` drives the Roundtable package's peer controls on FULI's local
// console. Its changes carry the data directory's human-review token, as
// `fuli open` does (rec#11 D-61); without one the console refuses them.
export function runPeerCommand(args, { env = process.env, fetchImpl = fetch, write = console.log, readToken = humanReviewToken } = {}) {
  const paths = () => resolveSetupPaths({ dataDir: option(args, '--data-dir'), env });
  const baseUrl = () => {
    const resolved = paths();
    const settings = resolved.runtimeSettingsPath ? readRuntimeSettings(resolved.runtimeSettingsPath) : DEFAULT_RUNTIME_SETTINGS;
    return `http://127.0.0.1:${settings.ports.console}`;
  };
  const ownerHeaders = () => {
    try {
      return { [SIGN_IN_TOKEN_HEADER]: readToken(paths().dataDir) };
    } catch {
      return {};
    }
  };
  return runPeerControlCommand(args, { baseUrl, command: 'fuli', fetchImpl, write, ownerHeaders,
    notRunning: 'The local FULI console is not running; start it with `fuli start`.' });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
