import { Agent, request as httpsRequest } from 'node:https';

import { PEER_LIMITS, PeerError, parseCoordinatorUrl, sha256Hex } from './protocol.js';

// Talks to exactly one coordinator: trusted only through its pinned
// certificate, never redirected, and always presenting this device's certificate.
export function createPeerClient({ identity, coordinator }) {
  const origin = parseCoordinatorUrl(coordinator.url);
  const tls = pinnedTls(identity, coordinator);
  const agent = new Agent({ ...tls, keepAlive: true, maxSockets: 4 });
  return {
    post: (path, body, options = {}) => post(origin, path, body, { ...options, agent }),
    close: () => agent.destroy(),
  };
}

// Pairing uses its own connection: the coordinator only trusts this device after it succeeds.
export function pairWithCoordinator({ identity, authority, invitation, name, timeoutMs = 15_000 }) {
  const coordinator = { url: invitation.url, certPem: invitation.certificatePem, fingerprint: invitation.fingerprint };
  return post(parseCoordinatorUrl(invitation.url), '/peer/1/pair', { code: invitation.code, name, authority },
    { agent: false, tls: pinnedTls(identity, coordinator), timeoutMs });
}

function pinnedTls(identity, coordinator) {
  return {
    ...identity.tlsOptions,
    ca: [coordinator.certPem],
    minVersion: 'TLSv1.3',
    checkServerIdentity: (_host, certificate) => (certificate?.raw && sha256Hex(certificate.raw) === coordinator.fingerprint
      ? undefined : new PeerError('fingerprint_mismatch', 'The coordinator certificate does not match the paired fingerprint', 502)),
  };
}

function post(origin, path, body, { agent, tls = {}, timeoutMs = 15_000, signal } = {}) {
  const url = new URL(path, origin);
  const payload = Buffer.from(JSON.stringify(body ?? {}));
  if (payload.length > PEER_LIMITS.requestBytes) return Promise.reject(new PeerError('payload_too_large', 'Request body is too large', 413));
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) { request.destroy(); reject(error); } else resolve(value);
    };
    // An absolute deadline covers slow headers, a stalled body and a half-closed TLS stream alike.
    const deadline = setTimeout(() => settle(new PeerError('coordinator_timeout', 'The coordinator did not respond in time', 504)), timeoutMs);
    const request = httpsRequest(url, { method: 'POST', agent, ...tls, signal,
      headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (response) => {
      let size = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > PEER_LIMITS.responseBytes) settle(new PeerError('response_too_large', 'Coordinator response is too large', 502));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = undefined; }
        const object = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        if (response.statusCode >= 200 && response.statusCode < 300) {
          return object ? settle(null, object) : settle(new PeerError('invalid_response', 'The coordinator sent an invalid response', 502));
        }
        settle(new PeerError(typeof object?.error === 'string' ? object.error : 'coordinator_error',
          typeof object?.message === 'string' ? object.message : `Coordinator responded ${response.statusCode}`, response.statusCode));
      });
      const interrupted = () => settle(new PeerError('response_interrupted', 'The coordinator response was interrupted', 502));
      response.on('aborted', interrupted);
      response.on('error', interrupted);
      response.on('close', () => { if (!response.complete) interrupted(); });
    });
    request.on('error', (error) => settle(error instanceof PeerError ? error
      : error.code === 'ABORT_ERR' ? new PeerError('aborted', 'The request was cancelled', 499)
      : /CERT|SELF_SIGNED|DEPTH|SSL|TLS|ECONNRESET/.test(String(error.code)) ? new PeerError('tls_rejected', 'The secure connection was rejected', 502)
      : new PeerError('coordinator_unreachable', 'The coordinator is unreachable', 503)));
    request.end(payload);
  });
}
