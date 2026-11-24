import { GraphitiProviderClient } from '../graphiti/provider-client.js';
import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';

// What this computer's own graph holds of the person's, asked of its own
// Provider directly. On a computer that follows a host, the console port
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

async function askOwnProvider(configPath, { fetchImpl = globalThis.fetch, readConfig = readGraphRuntimeConfig,
  timeoutMs = 10_000 } = {}, ask) {
  const { personal } = readConfig(configPath);
  const provider = new GraphitiProviderClient({ baseUrl: personal.providerUrl, accessToken: personal.accessToken,
    fetchImpl, requestTimeoutMs: timeoutMs });
  try { return await ask(provider, personal.spaceId); } catch (error) {
    if (error?.status === 0 || error?.status === 504) return { unreachable: true };
    return { refused: error?.status ?? 500, code: error?.code ?? 'provider_error' };
  }
}
