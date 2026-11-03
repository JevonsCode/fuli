import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../../agent-kits/client-installer.js';
import { acquireFileLock } from '../../storage/file-lock.js';
import { readClientPackState, writeClientPackState, installedClientPacks } from './client-pack-store.js';
import { loadClientDescriptorPacks } from './descriptor-packs.js';
import { compareSemanticVersions } from '../../semantic-version.js';

// Makes a reviewed client pack the active one (rec#18 D-10). The pack decides
// what FULI's installer manifest asks for in its client (pack-manifest.js),
// so for a client FULI is in, agent-installer's plan with the new pack is
// shown and written only after the person agrees; agent-installer backs up
// each file first. FULI writes no client file itself (rec#11 #11).
// installer: the client installer port, or null when FULI is not in the client.
export async function changeClientPack({ dataDir, pack, rollback = false, installer, confirm, write }) {
  const builtin = loadClientDescriptorPacks().find(value => value.id === pack.id);
  loadClientDescriptorPacks({ trustedOverrides: [pack] });
  write(`Built-in descriptor:\n${JSON.stringify(builtin, null, 2)}\nProposed descriptor:\n${JSON.stringify(pack, null, 2)}`);
  if (!await confirm(`Install ${pack.id}@${pack.version}? [y/N] `, { defaultYes: false })) return { status: 'cancelled' };
  const release = acquireFileLock(join(dataDir, '.client-pack-operation.lock'));
  try {
    const state = readClientPackState(dataDir);
    const current = installedClientPacks(dataDir).find(value => value.id === pack.id);
    if (!rollback && compareSemanticVersions(pack.version, current.version) <= 0) return { status: 'current' };
    if (compareSemanticVersions(pack.version, builtin.version) < 0) throw new TypeError('Rollback cannot go below the built-in version');
    const key = `${pack.id}@${pack.version}`;
    if (state.packages[key] && state.packages[key].digest !== pack.digest) throw new TypeError('Installed version has different content');
    const next = structuredClone(state);
    next.packages[key] = pack;
    next.history[pack.id] = rollback ? (state.history[pack.id] ?? []).slice(0, -1) : [...(state.history[pack.id] ?? []), current];
    next.active[pack.id] = key;
    next.ledger.push({ operation: randomUUID(), id: pack.id, from: current.version, to: pack.version, status: 'applied', rollback });
    writeClientPackState(dataDir, next);
  } finally { release(); }
  const files = installer ? await reconnect(installer, pack.id, { confirm, write }) : 0;
  return { status: 'applied', version: pack.version, files };
}

// Shows agent-installer's plan for the client and applies it on consent;
// answers how many files it changed.
async function reconnect(installer, id, { confirm, write }) {
  const planned = await installer.plan([id]);
  if (planned.status !== 'available') {
    write(`${CLIENT_COMPONENT_UNAVAILABLE}\nThe client files were not changed; run fuli setup to update them.`);
    return 0;
  }
  const changes = planned.clients.find(client => client.id === id)?.changes ?? [];
  if (!changes.length) return 0;
  for (const change of changes) write(`File: ${change.path} (${change.action})\n${change.diff ?? ''}`);
  if (!await confirm(`Write ${changes.length === 1 ? 'this file' : `these ${changes.length} files`}? [y/N] `, { defaultYes: false })) {
    write('The client files were not changed; run fuli setup to update them.');
    return 0;
  }
  const applied = await installer.apply([id]);
  if (applied.status !== 'available') throw new Error(CLIENT_COMPONENT_UNAVAILABLE);
  const client = applied.clients.find(value => value.id === id);
  for (const problem of client?.problems ?? []) write(`Not changed: ${problem}`);
  return client?.changes.length ?? 0;
}
