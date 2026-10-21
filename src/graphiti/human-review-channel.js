import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseProviderEnv } from '../setup/provider-env.js';

// The personal provider as a person's own console and CLI reach it for the
// operations that change real data on their word: a confirmed data format
// migration (rec#17 D-09) and a hard delete (rec#5 C9). Those provider
// routes also take the human-review token, which only the provider's
// environment file in the data directory holds; an Agent's access token alone
// is refused. Only `fuli migrate` and the local console's loopback routes use
// this module; no MCP or Agent tool module imports it
// (test/data-format-console.test.js, test/knowledge-hard-delete-console.test.js).

const REQUEST_TIMEOUT_MS = 30_000;

// send(path, body, { review, timeoutMs }) -> { ok, status, payload }
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
  return async (path, body, { review = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) => {
    const { providerUrl, accessToken } = connection();
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
      ...(review ? { 'x-fuli-human-review-token': reviewToken() } : {}) };
    const response = await fetchImpl(`${providerUrl}${path}`, { method: 'POST', headers,
      body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs) });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  };
}
