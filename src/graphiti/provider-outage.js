import { ProviderRequestError } from './provider-client.js';

// The Graph Provider did not answer (not running, restarting, or a gateway in
// front of it failed): a later attempt may succeed. A refusal or a bad request
// is an answer and never counts.
export function isProviderOutage(error) {
  if (!(error instanceof ProviderRequestError)) return false;
  return ['provider_unavailable', 'provider_timeout'].includes(error.code)
    || (error.code === 'provider_http_5xx' && [502, 503, 504].includes(error.status));
}
