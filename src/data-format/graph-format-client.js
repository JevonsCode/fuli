import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DataFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { parseProviderEnv } from '../setup/provider-env.js';

// The personal graph's side of a person's migration (rec#17 D-09 part 2),
// through its provider. Preview needs the ordinary access token; apply and
// rollback also send the human-review token, which only the provider's
// environment file holds. This module is used by `fuli migrate` and the local
// console; no MCP or Agent tool module imports it.

const REQUEST_TIMEOUT_MS = 30_000;
// A confirmed step may journal and rewrite many records in one transaction.
const CHANGE_TIMEOUT_MS = 10 * 60_000;

export function personalGraphFormat(dataDir, { fetchImpl = fetch, readText = (path) => readFileSync(path, 'utf8') } = {}) {
  const connection = () => {
    const config = JSON.parse(readText(join(dataDir, 'graph-runtime.json')));
    const providerUrl = config?.personal?.providerUrl;
    const accessToken = config?.personal?.accessToken;
    if (typeof providerUrl !== 'string' || typeof accessToken !== 'string') {
      throw new TypeError('The personal graph connection is not set up');
    }
    return { providerUrl: providerUrl.replace(/\/$/, ''), accessToken };
  };
  const reviewToken = () => {
    const token = parseProviderEnv(readText(join(dataDir, 'graph-provider.env'))).FULI_PERSONAL_HUMAN_REVIEW_TOKEN;
    if (!token) throw new TypeError('The graph provider has no human-review channel; run fuli setup again');
    return token;
  };
  const request = async (path, body, { review = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
    const { providerUrl, accessToken } = connection();
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      ...(review ? { 'x-fuli-human-review-token': reviewToken() } : {}) };
    const response = await fetchImpl(`${providerUrl}${path}`, { method: 'POST', headers,
      body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    const detail = payload?.detail;
    if (detail?.code) throw new DataFormatError('graph', detail.code, detail.message, detail.steps ?? []);
    throw new DataFormatError('graph', 'data_format_graph_unavailable',
      `The graph provider answered HTTP ${response.status}${typeof detail === 'string' ? `: ${detail}` : ''}.`);
  };
  return {
    // { plan, undoable } where plan is null when nothing waits for a person.
    async preview() {
      try {
        return await request('/v1/data-format/preview');
      } catch (error) {
        if (error?.code === 'ENOENT') return { plan: null, undoable: [] };
        return { plan: { store: 'graph', kind: 'neo4j', action: 'unavailable', steps: [],
          reason: error instanceof DataFormatError ? error.message
            : 'its provider is not answering; start FULI to inspect the graph' }, undoable: [] };
      }
    },
    apply: (digest, entrypoint) => request('/v1/data-format/apply', { digest, entrypoint },
      { review: true, timeoutMs: CHANGE_TIMEOUT_MS }),
    rollback: (migrationId, entrypoint) => request('/v1/data-format/rollback',
      { migration_id: migrationId, entrypoint }, { review: true, timeoutMs: CHANGE_TIMEOUT_MS })
  };
}
