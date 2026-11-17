import { localConsoleUrl } from './console-url.js';
import { runPeerControlCommand } from '../../packages/roundtable/src/peer/control-cli.js';

// `fuli peer` drives the Roundtable package's peer controls on FULI's local console.
export function runPeerCommand(args, { env = process.env, fetchImpl = fetch, write = console.log } = {}) {
  const baseUrl = () => localConsoleUrl({ dataDir: option(args, '--data-dir'), env });
  return runPeerControlCommand(args, { baseUrl, command: 'fuli', fetchImpl, write,
    notRunning: 'The local FULI console is not running; start it with `fuli start`.' });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
