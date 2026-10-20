import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectLocalStores } from './local-stores.js';

// Every store of one data directory and the graphs it uses, as `fuli migrate
// status` reports them (rec#17 D-09). Nothing here writes: local stores are
// opened read-only, and each graph reports itself from reads in Neo4j's read
// access mode. A store that cannot be read that way is 'unavailable', never
// opened another way.

const GRAPH_REPORT_TIMEOUT_MS = 10_000;

export async function collectFormatStatus({ dataDir, fetchImpl = fetch }) {
  return { dataDir, stores: [...inspectLocalStores(dataDir), ...await inspectGraphs(dataDir, fetchImpl)] };
}

async function inspectGraphs(dataDir, fetchImpl) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(dataDir, 'graph-runtime.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [graphReport('graph (personal)', { state: 'absent', note: 'FULI is not set up here' })];
    return [graphReport('graph (personal)', { state: 'unavailable', note: 'its connection settings cannot be read' })];
  }
  const providers = [['graph (personal)', config?.personal?.providerUrl],
    ...(Array.isArray(config?.workspaces) ? config.workspaces : [])
      .map((workspace, index) => [`graph (workspace ${index + 1})`, workspace?.providerUrl])];
  return Promise.all(providers.map(([label, url]) => inspectGraph(label, url, fetchImpl)));
}

async function inspectGraph(label, providerUrl, fetchImpl) {
  if (typeof providerUrl !== 'string' || !providerUrl) {
    return graphReport(label, { state: 'unavailable', note: 'no provider address is configured' });
  }
  let response;
  try {
    response = await fetchImpl(`${providerUrl.replace(/\/$/, '')}/health/data-format`,
      { signal: AbortSignal.timeout(GRAPH_REPORT_TIMEOUT_MS) });
  } catch {
    return graphReport(label, { state: 'unavailable',
      note: 'its provider is not answering; start FULI to inspect the graph' });
  }
  if (!response.ok) {
    return graphReport(label, { state: 'unavailable', note: response.status === 404
      ? 'its provider predates format reports; upgrade FULI' : `its provider answered HTTP ${response.status}` });
  }
  return { label, ...await response.json() };
}

function graphReport(label, fields) {
  return { label, store: 'graph', kind: 'neo4j', version: null, target: null, ledger: [], steps: [], ...fields };
}
