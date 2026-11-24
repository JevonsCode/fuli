import { readFileSync } from 'node:fs';

import { GraphitiProviderClient } from '../graphiti/provider-client.js';
import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readJsonFile } from '../storage/json-file.js';
import { RECRUITMENT_ON_OWNER } from './owner-recruitments.js';

// What this computer's own graph holds of the person's, asked of its own
// Provider directly, and the one write a follower makes to it (a copy's import). On a computer that follows a host, the console port
// answers with the host's pages and API for every path it does not own, so
// asking the console here would ask the host (the bug fixed with step 3a): the
// Provider is the one place that knows this computer's records.
//
// Each answers its own shape, or { unreachable: true } when the Provider does
// not answer (it is stopped while no scope is this computer's), or
// { refused: status, code } when it answered with an error. An unreadable
// graph-runtime.json throws, with its own message.

// The projects: { projects: [ids] }.
export async function localGraphProjects(configPath, options = {}) {
  return askOwnProvider(configPath, options, async (provider, spaceId) => {
    const listed = await provider.listPersonalProjects(spaceId);
    const projects = Array.isArray(listed) ? listed : Array.isArray(listed?.projects) ? listed.projects : [];
    return { projects: projects.map((project) => project?.project_id).filter((id) => typeof id === 'string' && id) };
  });
}

// The records of `global` other than the defaults its Provider makes by itself
// (habits, knowledge, FLAs the person hired): { count, labels: { label: n } }.
export async function localGraphOwnGlobal(configPath, options = {}) {
  return askOwnProvider(configPath, options, async (provider, spaceId) => {
    const answer = await provider.countOwnGlobalRecords(spaceId);
    return { count: Number.isInteger(answer?.count) ? answer.count : null, labels: answer?.labels ?? {} };
  });
}

// Whether this computer's own Provider runs now, and the formats and copy mode it says:
// { graph, replicaProtocol, globalReplica }. Only asked, never started (global-sync.js).
export async function localGraphHealth(configPath, options = {}) {
  return askOwnProvider(configPath, { timeoutMs: 3000, ...options }, async (provider) => {
    const health = await provider.health();
    return { graph: health?.data_format?.supported_version ?? null, replicaProtocol: health?.replicaProtocol ?? null,
      globalReplica: health?.globalReplica === true };
  });
}

// Whether this data directory's process record names a running personal Provider: read before
// anything is asked of it on loopback (global-sync.js), so a stopped runtime costs one small file.
export function localProviderRecorded(dataDir) {
  try {
    const state = readJsonFile(resolveSetupPaths({ dataDir }).nativeProcessStatePath, null);
    return Boolean(state?.providers?.personal);
  } catch { return false; }
}

// The one write a follower makes to its own graph: another computer's scope, imported as a
// read-only copy (docs/runner-roles-design.md §12 "Import"). envelope: the owner's export
// text as it arrived; owner: the certificate fingerprint the pairing pinned. { imported: result }.
export async function localGraphImport(configPath, { envelope, owner }, options = {}) {
  return askOwnProvider(configPath, options, async (provider) => ({ imported: await provider.importScope({ envelope, owner }) }));
}

export function localGraphReplicaSummary(configPath, options = {}) {
  return askOwnProvider(configPath, options, (provider, personalSpaceId) =>
    provider.replicaSummary({ personalSpaceId, scope: 'global' }));
}

export function localGraphRelease(configPath, owner, options = {}) {
  return askOwnProvider(configPath, options, (provider, personalSpaceId) =>
    provider.releaseScope({ personalSpaceId, owner }));
}

// The recruitments still waiting for the host to make their FLA (owner-recruitments.js): { count }.
export function localGraphWaitingRecruitments(configPath, options = {}) {
  return askOwnProvider(configPath, { timeoutMs: 3000, ...options }, async (provider, personalSpaceId) => {
    const listed = await provider.listProjectAgentRecruitments({ personalSpaceId, status: 'blocked' });
    const rows = Array.isArray(listed) ? listed : listed?.recruitments ?? listed?.items ?? [];
    return { count: rows.filter(row => row?.status === 'blocked' && row.reason_code === RECRUITMENT_ON_OWNER).length };
  });
}

// The personal space ID this computer's graph was made under, or null when none was made.
export function localGraphSpaceId(configPath) {
  try {
    const spaceId = JSON.parse(readFileSync(configPath, 'utf8'))?.personal?.spaceId;
    return typeof spaceId === 'string' && spaceId ? spaceId : null;
  } catch { return null; }
}

// refused also carries the Provider's message, as it said it.
async function askOwnProvider(configPath, { fetchImpl = globalThis.fetch, readConfig = readGraphRuntimeConfig,
  timeoutMs = 10_000 } = {}, ask) {
  const { personal } = readConfig(configPath);
  const provider = new GraphitiProviderClient({ baseUrl: personal.providerUrl, accessToken: personal.accessToken,
    fetchImpl, requestTimeoutMs: timeoutMs });
  try { return await ask(provider, personal.spaceId); } catch (error) {
    if (error?.status === 0 || error?.status === 504) return { unreachable: true, timedOut: error.status === 504 };
    return { refused: error?.status ?? 500, code: error?.code ?? 'provider_error', message: String(error?.message ?? '').slice(0, 300) };
  }
}
