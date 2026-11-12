import { FULI_VERSION } from '../package-metadata.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveSetupPaths } from '../setup/paths.js';
import { GRAPH_RUNTIME_CONFIG_FORMAT } from '../graphiti/runtime-config.js';
import { updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { confirmInTerminal, interactiveTerminal } from './terminal-io.js';
import { readPinnedClientManifest } from '../setup/agents/client-manifest.js';
import { installedClientPacks, readClientPackState } from '../setup/agents/client-pack-store.js';
import { loadClientDescriptorPacks as clientDescriptorPacks } from '../setup/agents/descriptor-packs.js';
import { changeClientPack } from '../setup/agents/client-pack-change.js';
import { detectClients, entryState } from '../agent-kits/client-detection.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../agent-kits/client-installer.js';
import { compareSemanticVersions } from '../semantic-version.js';

// clientInstaller: the client installer port for the setup paths
// (client-installer.js); agent-installer writes every client file.
export async function runClientsCommand(args, { env = process.env, write = console.log, fetchImpl = fetch,
  confirm = (question, options) => interactiveTerminal() ? confirmInTerminal(question, options) : false,
  homeDir = homedir(), platform = process.platform,
  clientInstaller = (paths) => agentKitPorts(paths, { env, homeDir }).clientInstaller } = {}) {
  const [action, ...rest] = args;
  if (!action || ['--help', '-h'].includes(action)) {
    write('fuli clients trust <https-url|local-path> --sha256 DIGEST [--data-dir DIR]\nfuli clients update [--check | --apply id@version] [--data-dir DIR]\nfuli clients status | rollback ID [--data-dir DIR]\nUpdates only preview unless --apply is given. Installation and each client file require separate default-no terminal confirmation; --yes never authorizes them.');
    return;
  }
  const options = new Map(); const positional = [];
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (!flag.startsWith('--')) { positional.push(flag); continue; }
    if (!['--sha256', '--data-dir', '--check', '--apply', '--yes'].includes(flag) || options.has(flag)) throw new TypeError(`Invalid clients option: ${flag}`);
    if (['--check', '--yes'].includes(flag)) options.set(flag, true);
    else { const value = rest[++index]; if (!value || value.startsWith('--')) throw new TypeError(`Missing value: ${flag}`); options.set(flag, value); }
  }
  if (options.has('--check') && options.has('--apply')) throw new TypeError('Choose --check or --apply');
  const paths = resolveSetupPaths({ dataDir: options.get('--data-dir'), env, homeDir, platform });
  const runtimePath = paths.graphRuntimeConfigPath;
  if (action === 'trust') {
    if (positional.length !== 1 || !options.has('--sha256')) throw new TypeError('trust needs a source and --sha256');
    const source = /^https?:\/\//i.test(positional[0]) ? positional[0] : resolve(positional[0]);
    const pin = { source, sha256: options.get('--sha256') };
    const result = await readPinnedClientManifest(pin, { fetchImpl });
    if (result.status !== 'verified') { write('Source unavailable; no changes.'); return result; }
    clientDescriptorPacks({ trustedOverrides: result.packs });
    write(JSON.stringify(pin, null, 2));
    if (!await confirm('Pin these exact manifest bytes? [y/N] ', { defaultYes: false })) return { status: 'cancelled' };
    updateVersionedJsonFileAtomic(runtimePath, GRAPH_RUNTIME_CONFIG_FORMAT, current => {
      if (!current) throw new Error('Configure the local runtime before pinning a client manifest');
      return { ...current, clientPackTrust: pin };
    });
    return { status: 'trusted' };
  }
  const active = installedClientPacks(paths.dataDir);
  if (action === 'status') {
    const state = readClientPackState(paths.dataDir);
    const builtins = clientDescriptorPacks();
    const status = active.map(pack => ({ id: pack.id, version: pack.version,
      retired: Boolean(state.active[pack.id] && compareSemanticVersions(state.packages[state.active[pack.id]].version,
        builtins.find(builtin => builtin.id === pack.id).version) <= 0) }));
    write(JSON.stringify(status, null, 2)); return status;
  }
  let pack;
  if (action === 'rollback') {
    if (positional.length !== 1) throw new TypeError('rollback needs one client id');
    pack =readClientPackState(paths.dataDir).history[positional[0]]?.at(-1);
    if (!pack) { write('No prior client pack; no changes.'); return { status: 'current' }; }
    const builtin = clientDescriptorPacks().find(value => value.id === pack.id);
    if (compareSemanticVersions(pack.version, builtin.version) < 0) pack = builtin;
  } else if (action === 'update') {
    if (positional.length) throw new TypeError('Unexpected clients update argument');
    write(`npm built-in descriptors: FULI v${FULI_VERSION}. Upgrade FULI to obtain newer npm built-ins.`);
    const config = existsSync(runtimePath) ? JSON.parse(readFileSync(runtimePath, 'utf8')) : {};
    if (!config.clientPackTrust) { write('No pinned manifest; using npm built-ins.'); return { status: 'current' }; }
    const result = await readPinnedClientManifest(config.clientPackTrust, { fetchImpl });
    if (result.status !== 'verified') { write('Source unavailable; no changes.'); return result; }
    clientDescriptorPacks({ trustedOverrides: result.packs });
    const newer = result.packs.filter(candidate => compareSemanticVersions(candidate.version, active.find(value => value.id === candidate.id).version) > 0);
    if (!options.has('--apply')) {
      for (const candidate of newer) write(`Built-in:\n${JSON.stringify(clientDescriptorPacks().find(value => value.id === candidate.id), null, 2)}\nProposed:\n${JSON.stringify(candidate, null, 2)}`);
      if (!newer.length) write('No newer client packs; no changes.');
      return { status: 'preview', packs: newer };
    }
    pack = newer.find(candidate => `${candidate.id}@${candidate.version}` === options.get('--apply'));
    if (!pack) { write('Requested newer pack unavailable; no changes.'); return { status: 'current' }; }
  } else throw new TypeError(`Unknown clients command: ${action}`);
  // Only a client agent-installer finds FULI's entry in has files to change.
  const installer = clientInstaller(paths);
  const detection = await detectClients(installer);
  if (detection.status !== 'available') {
    write(`${CLIENT_COMPONENT_UNAVAILABLE} (${detection.reason}); no changes.`);
    return { status: 'unavailable' };
  }
  const connected = ['current', 'outdated'].includes(entryState(detection.clients.find(({ id }) => id === pack.id)?.components));
  return changeClientPack({ dataDir: paths.dataDir, pack, rollback: action === 'rollback', installer: connected ? installer : null, confirm, write });
}
