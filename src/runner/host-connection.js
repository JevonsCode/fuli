import { Agent, request as httpsRequest } from 'node:https';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { discoveryAdapters } from '../../packages/roundtable/src/peer/lan-addresses.js';
import { createBonjourDiscovery } from '../../packages/roundtable/src/peer/nearby-discovery.js';
import { pinnedTls } from '../../packages/roundtable/src/peer/peer-transport.js';
import { isReachableHostAddress } from '../server/lan-access.js';
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
// Each address is also tried bound to each physical adapter's own address.
// On macOS that changes the way out, as scoped routing lets the source
// address pick the adapter: a VPN that claims the host's subnet sends the
// default route into its tunnel while the Wi-Fi or cable adapter reaches the
// host directly. On Linux the destination chooses the route, so these extra
// probes usually only cost a socket. Windows is not tried behind such a VPN
// (its strong host model may behave as macOS does). Where it does not help,
// the way through is an address reachable over the VPN itself (`fuli runner
// add-address`). The route that answers is the one every later request takes.
// The host's hello names its addresses now, kept for the next network change.
// The pinned host answering that it does not know this runner (revoked, or
// never paired there) ends the pairing here (runner-store.js revoked): nothing
// is looked for, shown from cache or sent again until the runner joins again.
const PROBE_MS = 2500;
const LOOK_MS = 3000;
const REQUEST_MS = 15_000;
// How long a status question waits for hello on a kept connection.
const HELLO_MS = 5000;
const SEEN_EVERY_MS = 30_000;
// The host's answer to a runner it does not know (host-routes.js).
const NOT_PAIRED = 'runner_unknown';

// report(): headers this follower sends with hello about itself (host-space.js followerReport).
export function createHostConnection({ store, identity, lookUp = lookUpHost, probeMs = PROBE_MS,
  bindAddresses = () => discoveryAdapters(networkInterfaces), report = () => ({}) }) {
  let current = null;
  let finding = null;
  // Whether the last search reached an address whose certificate is not the paired one.
  let pinFailed = false;
  let closed = false;
  // Aborts every request in flight at close(); an outbox entry it cut stays queued and is retried.
  const closing = new AbortController();

  // Concurrent callers share one search, so one agent is ever kept.
  // knownOnly: probe the addresses already known and skip mDNS, for a quick
  // re-check (a search already under way is shared as it is).
  function connect({ knownOnly = false } = {}) {
    if (current || closed) return Promise.resolve(current);
    finding ??= find({ knownOnly }).finally(() => { finding = null; });
    return finding;
  }

  async function find({ knownOnly }) {
    const host = store.host();
    if (!host || host.revokedAt) return null;
    pinFailed = false;
    const known = [...new Set([host.lastAddress, ...host.addresses].filter(Boolean))];
    if (await reachFirst(host, known)) return current;
    if (closed || knownOnly || store.host()?.revokedAt) return null;
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
    let local = [];
    try { local = bindAddresses(); } catch { local = []; }
    const routes = [null, ...new Set(local)];
    const probes = addresses.flatMap((address) => routes.map((via) => probe(host, address, tls, signal, via)));
    const winner = await Promise.any(probes).catch(() => null);
    stop.abort();
    for (const outcome of await Promise.allSettled(probes)) {
      if (outcome.status === 'fulfilled' && (outcome.value !== winner || closed)) outcome.value.agent.destroy();
    }
    if (!winner || closed) return false;
    current = winner;
    store.hostAnsweredAt(winner.address);
    if (winner.announced.length) store.learnHostAddresses(winner.announced);
    return true;
  }

  // via: the local address to connect from (an adapter's own), or null for the default route.
  async function probe(host, address, tls, signal, via = null) {
    const agent = new Agent({ ...tls, keepAlive: true, maxSockets: 16, ...(via ? { localAddress: via } : {}) });
    const candidate = { address, via, origin: `https://${address}:${host.port}`, fetch: seenFetch(pinnedFetch(agent)),
      agent, announced: [], greeting: null };
    try {
      const answer = await candidate.fetch(`${candidate.origin}${RUNNER_PATHS.hello}`, { signal, headers: report() });
      const body = [200, 403].includes(answer.status) ? await answer.json().catch(() => null) : await answer.body?.cancel();
      if (body?.error === NOT_PAIRED) store.revoked();
      if (answer.status !== 200) throw new Error(`hello ${answer.status}`);
      // Only addresses a host serves (private, or the VPN range it binds on a
      // VPN adapter), as the ones mDNS finds: no request goes anywhere else.
      candidate.announced = (Array.isArray(body?.addresses) ? body.addresses : []).filter(isReachableHostAddress);
      // What this hello said, for a caller that wants it (the sessions this
      // runner holds): the search already asked, so nothing asks again.
      candidate.greeting = body ?? null;
      return candidate;
    } catch (error) {
      agent.destroy();
      if (isPinFailure(error)) pinFailed = true;
      throw error;
    }
  }

  // A request that failed for the network forgets the address; the next one looks again.
  function drop() {
    current?.agent.destroy();
    current = null;
  }

  // A request on a connection that went stale (the host restarted, the
  // network changed) is made once more after looking for the host again. One
  // that timed out may have reached the host and is not sent again here: its
  // caller decides (an outbox entry is delivered again later, under its id).
  // revoked: the host does not know this runner any more.
  async function postJson(path, body, { timeoutMs = REQUEST_MS } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const connection = await connect();
      if (!connection) return { reachable: false, revoked: Boolean(store.host()?.revokedAt) };
      // timeoutMs bounds the wait; close() still cuts it at once.
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const answer = await connection.fetch(`${connection.origin}${path}`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.any([timeout, closing.signal]) });
        const text = await answer.text();
        let value = null;
        try { value = text ? JSON.parse(text) : null; } catch { value = null; }
        if (answer.status === 403 && value?.error === NOT_PAIRED) {
          drop();
          store.revoked();
          return { reachable: true, status: 403, body: value, revoked: true };
        }
        return { reachable: true, status: answer.status, body: value };
      } catch {
        drop();
        if (closed) return { reachable: false };
        if (timeout.aborted) return { reachable: false, timedOut: true };
      }
    }
    return { reachable: false };
  }

  // A GET whose answer is read as text, at most maxBytes of it (a scope's envelope,
  // global-sync.js): { reachable, status, text, headers } or, past maxBytes,
  // { reachable, status, tooLarge: true } with nothing kept. The bytes are decoded
  // once and never parsed here.
  async function getText(path, { timeoutMs = REQUEST_MS, maxBytes }) {
    const connection = await connect();
    if (!connection) return { reachable: false, revoked: Boolean(store.host()?.revokedAt) };
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const answer = await connection.fetch(`${connection.origin}${path}`, { signal: AbortSignal.any([timeout, closing.signal]) });
      const bytes = await readAtMost(answer, maxBytes);
      if (bytes === null) return { reachable: true, status: answer.status, tooLarge: true };
      const text = new TextDecoder('utf-8').decode(bytes);
      if (answer.status === 403 && jsonError(text) === NOT_PAIRED) {
        drop();
        store.revoked();
        return { reachable: true, status: 403, revoked: true };
      }
      return { reachable: true, status: answer.status, text, headers: answer.headers };
    } catch {
      drop();
      return { reachable: false, ...(timeout.aborted ? { timedOut: true } : {}) };
    }
  }

  // The host's hello answer now (its name, version and the MCP sessions this
  // runner holds there), or null when it does not answer. A search that just
  // found the host already asked, so that answer is given once instead of
  // asking again; a later call asks, since the counts move. A kept connection
  // proves nothing about now (review of #1069), but a hello that went unanswered
  // on it does not prove the host is gone either: the connection also carries
  // the host's pages and live event streams. So the host is looked for again,
  // the whole way, on a fresh connection, while the old one keeps what is in
  // flight on it and is ended only once it carries nothing.
  async function hello() {
    const connection = await connect();
    if (!connection) return null;
    if (connection.greeting) {
      const greeting = connection.greeting;
      connection.greeting = null;
      return greeting;
    }
    try {
      const answer = await connection.fetch(`${connection.origin}${RUNNER_PATHS.hello}`,
        { signal: AbortSignal.any([AbortSignal.timeout(HELLO_MS), closing.signal]), headers: report() });
      if (answer.status === 200) return await answer.json();
      await answer.body?.cancel();
    } catch { /* not answering on this connection: looked for again below */ }
    if (current !== connection) return null;
    // New requests stop taking the old connection; what is in flight on it finishes there (a host that
    // is gone ends it itself), and the old connection is ended once it carries nothing.
    current = null;
    retireWhenIdle(connection.agent);
    // The whole search, known addresses and mDNS, as any other look for the host.
    const fresh = await connect();
    if (!fresh) return null;
    const greeting = fresh.greeting;
    fresh.greeting = null;
    return greeting;
  }

  // An agent no longer used for new requests, ended once what it still carries has finished.
  function retireWhenIdle(agent) {
    const idle = () => !Object.values(agent.sockets).some((sockets) => sockets.length)
      && !Object.values(agent.requests).some((queued) => queued.length);
    if (idle()) { agent.destroy(); return; }
    const check = () => { if (idle()) { agent.off('free', check); agent.destroy(); } };
    agent.on('free', check);
    for (const sockets of Object.values(agent.sockets)) for (const socket of sockets) socket.once('close', check);
  }

  // Every request the pinned host answered, whatever it answered, is a moment
  // this computer reached it: what the console and `fuli status` show as
  // 「上次连上」. Written at most once per SEEN_EVERY_MS.
  let seenAt = 0;
  function seenFetch(fetchImpl) {
    return async (input, init) => {
      const answer = await fetchImpl(input, init);
      if (Date.now() - seenAt > SEEN_EVERY_MS) {
        seenAt = Date.now();
        try { store.hostSeen(); } catch { /* a store closed at shutdown */ }
      }
      return answer;
    };
  }

  function close() {
    closed = true;
    closing.abort();
    drop();
  }

  return { connect, drop, postJson, getText, hello, get current() { return current; }, get pinFailed() { return pinFailed; }, close };
}

// The body's bytes, or null once more than maxBytes arrived (the rest is not read).
async function readAtMost(answer, maxBytes) {
  if (Number(answer.headers.get('content-length')) > maxBytes) {
    await answer.body?.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  const reader = answer.body?.getReader();
  for (let read = await reader?.read(); read && !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(read.value);
  }
  return Buffer.concat(chunks);
}

function jsonError(text) {
  try { return JSON.parse(text)?.error ?? null; } catch { return null; }
}

// Something answered at the address with another certificate than the paired one
// (a host reinstalled with a new identity, or another device there).
function isPinFailure(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '');
  return code === 'fingerprint_mismatch' || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code);
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
    // Only an address the host's listener can serve: a pinned certificate is
    // checked there anyway, but no request goes anywhere else.
    discovery.browse({ onUp: (service) => {
      if (service.txt?.fp !== fingerprint) return;
      for (const address of service.addresses ?? []) if (isReachableHostAddress(address)) found.add(address);
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
