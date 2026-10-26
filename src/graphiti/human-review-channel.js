import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProviderEnv } from '../setup/provider-env.js';
import { ProviderRequestError } from './provider-client.js';

// The personal provider as a person's own console and CLI reach it for the
// operations that change real data on their word: a confirmed data format
// migration (rec#17 D-09), a hard delete (rec#5 C9) and a change of where
// knowledge applies, one item or a session's batch (rec#20, rec#11 D-22).
// The console's full reads of knowledge (graph, item, receipt, session
// records) take it too; without it the provider reads as an Agent and hides
// every FLA's own knowledge (src/knowledge-owner-reads).
// Those provider routes also take the human-review token, which only the
// provider's environment file in the data directory holds; an Agent's access
// token alone is refused. Like D-21 this proves the local console, not that a
// person was present: any process of the same OS account can read that file.
// Only `fuli migrate` and the local console's loopback routes use this module;
// no MCP or Agent tool module imports it (test/data-format-console.test.js,
// test/knowledge-hard-delete-console.test.js, test/session-knowledge-migration.test.js).

const REQUEST_TIMEOUT_MS = 30_000;

// send(path, body, { review, timeoutMs, method }) -> { ok, status, payload }; a GET sends no body.
export function personalHumanReviewChannel(dataDir, {
  fetchImpl = fetch,
  readText = (path) => readFileSync(path, 'utf8')
} = {}) {
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
  return async (path, body, { review = false, timeoutMs = REQUEST_TIMEOUT_MS, method = 'POST' } = {}) => {
    const { providerUrl, accessToken } = connection();
    const headers = { authorization: `Bearer ${accessToken}`,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      ...(review ? { 'x-fuli-human-review-token': reviewToken() } : {}) };
    const response = await fetchImpl(`${providerUrl}${path}`, { method, headers,
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }), signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  };
}

// The provider's refusal on this channel as the console reports it: its code
// and message, when a deleted item was deleted, and which items a refused
// batch names.
export function providerRefusal(status, payload) {
  const detail = payload?.detail;
  const code = typeof detail?.code === 'string' ? detail.code : status >= 500 ? 'provider_http_5xx' : 'provider_error';
  const message = typeof detail?.message === 'string' ? detail.message
    : typeof detail === 'string' && status < 500 ? detail : `The graph provider answered HTTP ${status}`;
  const deletedAt = typeof detail?.deleted_at === 'string' ? detail.deleted_at : undefined;
  const items = Array.isArray(detail?.items) ? detail.items : Array.isArray(detail?.stale_items) ? detail.stale_items : undefined;
  const details = deletedAt || items ? { ...(deletedAt ? { deletedAt } : {}), ...(items ? { items } : {}) } : null;
  return new ProviderRequestError(message, { status, code, details });
}
