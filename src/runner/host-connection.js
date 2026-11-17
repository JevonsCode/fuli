import { Agent, request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { discoveryAdapters } from '../../packages/roundtable/src/peer/lan-addresses.js';
import { createBonjourDiscovery } from '../../packages/roundtable/src/peer/nearby-discovery.js';
import { pinnedTls } from '../../packages/roundtable/src/peer/peer-transport.js';
import { RUNNER_PATHS, RUNNER_SERVICE_TYPE } from './protocol.js';

// A runner's way to its host (docs/runner.md). Every request is TLS 1.3 to
// exactly the paired certificate, presenting this device's own. The host is
// looked for at every address it was known by at once (the one that answered
// last among them), then by its fingerprint over mDNS; an address counts only
// when the pinned host answers there, and the first that does is kept. A
// client's MCP start waits on this, so the known addresses share one budget of
// PROBE_MS and mDNS stops at the first announcement. fetch() is what the MCP
// client and the outbox use. close() ends every connection and any probe still
// running, and nothing is opened after it.
const PROBE_MS = 2500;
const LOOK_MS = 3000;
const REQUEST_MS = 15_000;

export function createHostConnection({ store, identity, lookUp = lookUpHost, probeMs = PROBE_MS }) {
  let current = null;
  let finding = null;
  let closed = false;
  // Aborts every request in flight at close(); an outbox entry it cut stays queued and is retried.
  const closing = new AbortController();

  // Concurrent callers share one search, so one agent is ever kept.
  function connect() {
    if (current || closed) return Promise.resolve(current);
    finding ??= find().finally(() => { finding = null; });
    return finding;
  }

  async function find() {
    const host = store.host();
    if (!host) return null;
    const known = [...new Set([host.lastAddress, ...host.addresses].filter(Boolean))];
    if (await reachFirst(host, known)) return current;
    if (closed) return null;
    const announced = (await lookUp(host.fingerprint)).filter((address) => !known.includes(address));
    return await reachFirst(host, announced) ? current : null;
  }

  // Probes every address at once within probeMs; the first that answers as the
  // pinned host is kept and the other probes are stopped and released.
  async function reachFirst(host, addresses) {
    if (!addresses.length || closed) return false;
    const tls = pinnedTls(identity, { certPem: host.certPem, fingerprint: host.fingerprint });
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(probeMs)]);
    const probes = addresses.map((address) => probe(host, address, tls, signal));
    const winner = await Promise.any(probes).catch(() => null);
    stop.abort();
    for (const outcome of await Promise.allSettled(probes)) {
      if (outcome.status === 'fulfilled' && (outcome.value !== winner || closed)) outcome.value.agent.destroy();
    }
    if (!winner || closed) return false;
    current = winner;
    store.hostAnsweredAt(winner.address);
    return true;
  }

  async function probe(host, address, tls, signal) {
    const agent = new Agent({ ...tls, keepAlive: true, maxSockets: 16 });
    const candidate = { address, origin: `https://${address}:${host.port}`, fetch: pinnedFetch(agent), agent };
    try {
      const answer = await candidate.fetch(`${candidate.origin}${RUNNER_PATHS.hello}`, { signal });
      await answer.body?.cancel();
      if (answer.status !== 200) throw new Error(`hello ${answer.status}`);
      return candidate;
    } catch (error) {
      agent.destroy();
      throw error;
    }
  }

  // A request that failed for the network forgets the address; the next one looks again.
  function drop() {
    current?.agent.destroy();
    current = null;
  }

  // A request on a connection that went stale (the host restarted, the
  // network changed) is made once more after looking for the host again.
  async function postJson(path, body) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await connect();
      if (!connection) return { reachable: false };
      try {
        const answer = await connection.fetch(`${connection.origin}${path}`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(REQUEST_MS), closing.signal]) });
        const text = await answer.text();
        let value = null;
        try { value = text ? JSON.parse(text) : null; } catch { value = null; }
        return { reachable: true, status: answer.status, body: value };
      } catch {
        drop();
      }
    }
    return { reachable: false };
  }

  function close() {
    closed = true;
    closing.abort();
    drop();
  }

  return { connect, drop, postJson, get current() { return current; }, close };
}

// fetch() over one pinned agent, enough for the MCP client's Streamable HTTP
// transport: a streamed body that the caller reads or cancels.
export function pinnedFetch(agent) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    const body = init.body === undefined || init.body === null ? null : Buffer.from(init.body);
    const request = httpsRequest(url, { method: init.method ?? 'GET', agent, headers, signal: init.signal }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        for (const one of [].concat(value ?? [])) responseHeaders.append(name, one);
      }
      const empty = response.statusCode === 204 || response.statusCode === 304 || init.method === 'HEAD';
      if (empty) response.resume();
      resolve(new Response(empty ? null : Readable.toWeb(response), { status: response.statusCode, headers: responseHeaders }));
    });
    request.on('error', reject);
    request.end(body ?? undefined);
  });
}

// The IPv4 addresses a host with this fingerprint announces over mDNS, from
// its first announcement within waitMs.
async function lookUpHost(fingerprint, { waitMs = LOOK_MS,
  createDiscovery = (options) => createBonjourDiscovery(options) } = {}) {
  const found = new Set();
  const heard = new AbortController();
  let discovery = null;
  try {
    discovery = createDiscovery({ serviceType: RUNNER_SERVICE_TYPE, adapters: () => discoveryAdapters(networkInterfaces) });
    discovery.browse({ onUp: (service) => {
      if (service.txt?.fp !== fingerprint) return;
      for (const address of service.addresses ?? []) if (isIPv4(address)) found.add(address);
      if (found.size) heard.abort();
    }, onDown: () => {} });
    await delay(waitMs, null, { signal: heard.signal }).catch(() => {});
  } catch {
    // No multicast here: the known addresses were all there was to try.
  } finally {
    discovery?.close();
  }
  return [...found];
}
