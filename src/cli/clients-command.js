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
import { clientDescriptorPacks, clientPackTarget, agentAdapter } from '../setup/agents/registry.js';
import { changeClientPack, recoverClientPack } from '../setup/agents/client-pack-change.js';
import { parseMcpJson } from '../setup/agents/json-mcp.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { platformPath } from '../system/platform-path.js';

export async function runClientsCommand(args, { env = process.env, write = console.log, fetchImpl = fetch,
  confirm = (question, options) => interactiveTerminal() ? confirmInTerminal(question, options) : false,
  homeDir = homedir(), platform = process.platform, writeFile } = {}) {
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
      recoveryRequired: state.ledger.some(entry => entry.id === pack.id && (entry.status === 'pending' || entry.restoreFailures?.length)),
      retired: Boolean(state.active[pack.id] && compareSemanticVersions(state.packages[state.active[pack.id]].version,
        builtins.find(builtin => builtin.id === pack.id).version) <= 0) }));
    write(JSON.stringify(status, null, 2)); return status;
  }
  let pack;
  if (action === 'rollback') {
    if (positional.length !== 1) throw new TypeError('rollback needs one client id');
    const recovered = await recoverClientPack({ dataDir: paths.dataDir, id: positional[0], confirm, write, writeFile });
    if (recovered) return recovered;
    pack = readClientPackState(paths.dataDir).history[positional[0]]?.at(-1);
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
  const current = active.find(value => value.id === pack.id);
  const adapter = agentAdapter(current.id, paths.dataDir);
  const environment = { env, homeDir, pathApi: platformPath(platform), fileExists: existsSync, commandExists: () => false };
  const agent = adapter.detect(environment);
  const readText = path => path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  const context = { nodePath: process.execPath, mcpServerPath: paths.mcpServerPath, runtimeConfigPath: runtimePath };
  const connected = adapter.status(agent, context, { readText, readJson: (path, options) => { const value = readText(path); return value ? parseMcpJson(value, options) : {}; }, bootstrapCurrent: () => false }).registration.present;
  return changeClientPack({ dataDir: paths.dataDir, pack, rollback: action === 'rollback', agent: connected ? clientPackTarget(pack, environment) : null, context, confirm, write, writeFile });
}
