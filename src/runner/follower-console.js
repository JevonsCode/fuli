import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { handleClientConnectionRequest } from '../http/client-connection-api-router.js';
import { readJson, sendJson } from '../http/response.js';
import { FULI_VERSION } from '../package-metadata.js';
import { isReachableHostAddress } from '../server/lan-access.js';
import { listenServer } from '../server/listen.js';
import { BAND_PATH, BAND_SOURCE, bandTag, SOURCE_HEADER, STATUS_PATH } from './follower-band.js';
import { localRuntimeLine, prepareInBackground, readLocalRuntime } from './follower-local-runtime.js';
import { ADDRESS_PATH, followerConsolePage, outbox as outboxHtml, PREPARE_PATH, SYNC_PATH } from './follower-page.js';
import { followerLine, followerStatus } from './follower-status.js';
import { deliverOutbox } from './outbox-delivery.js';
import { RUNNER_PATHS, SAME_ORIGIN_HEADER } from './protocol.js';

// A follower's console entry (docs/runner.md, docs/runner-roles-design.md §5):
// on this computer's loopback, at the port its own console would use, so
// FULI.app, `fuli open` and the receipt links the host gives
// (http://127.0.0.1:<port>/…) all open here.
//
// What is this computer's and what is the host's:
//
// - LOCAL_PATH is this computer's own console page: who it follows, what runs
//   where, and every record still waiting for the host, with 「现在重试」. It
//   opens whether or not the host answers, and is what a path the host cannot
//   serve falls back to.
// - `/remote/<host>/…` names the host a page belongs to. It reaches only a
//   host this computer is paired with, over that pairing's channel; any other
//   name reaches nothing. An HTML page under it is answered with the host's own
//   path on this origin, because the host's console is one page application
//   that reads its own absolute paths.
// - Every other path is the host's, carried over the paired channel as it is
//   (console-relay.js on the host), with this computer's state band added to
//   its HTML (follower-band.js).
// - STATUS_PATH answers here, never from the host: it is how `fuli status` and
//   the app know this entry is running, and what the band reads.
// - 客户端接入 (/api/system/client-connection…) answers here from `clients`
//   (runner-clients.js): the clients that matter on a follower are its own.
//
// Every answer carries SOURCE_HEADER, so the band can say where this page's
// data came from instead of the person having to know.
export { STATUS_PATH } from './follower-band.js';
export const LOCAL_PATH = '/local';
const REMOTE_PREFIX = '/remote/';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'host', 'origin', 'referer']);
// An HTML page is read into memory to add the band; a larger one is passed through as it is.
const INJECT_LIMIT = 4 * 1024 * 1024;


// Which computer answers a path of this console: `local` (this computer's own
// page and state) or `host` (carried over the pairing). The one place that
// decides it; step 3c adds the pages and API of the scopes this computer owns,
// decided by scope here as well.
const OWN_PATHS = new Set([STATUS_PATH, BAND_PATH, SYNC_PATH, ADDRESS_PATH, PREPARE_PATH, LOCAL_PATH, `${LOCAL_PATH}/`]);
export function whoAnswers(pathname) {
  return OWN_PATHS.has(pathname) ? 'local' : 'host';
}

export async function startFollowerConsole({ dataDir, port, store, connection, clients = null, pid = process.pid,
  createServer = createHttpServer, deliver = deliverOutbox, prepare = prepareInBackground }) {
  let authorities = new Set();
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    handle(request, response).catch(() => {
      if (!response.headersSent) local(response, 500, { error: 'internal_error' });
      else response.destroy();
    });
  });

  const local = (response, status, body) => {
    response.setHeader(SOURCE_HEADER, 'local');
    sendJson(response, status, body);
  };
  // reachable: what this request already learned, for a caller that must not open the connection again.
  const status = ({ reach = true, reachable = null } = {}) =>
    followerStatus({ store, connection, dataDir, reach, reachable });

  async function handle(request, response) {
    // Only this computer, under its own name: another site's page cannot rebind a name onto it.
    if (!LOOPBACK.has(request.socket?.remoteAddress) || !authorities.has(String(request.headers.host ?? '').toLowerCase())) {
      local(response, 403, { error: 'forbidden' });
      return;
    }
    // Another site's page may not act on the host through this entry: its Origin is refused here,
    // before the channel, where the host could no longer tell it from this computer's own page.
    const origin = request.headers.origin;
    const sameOrigin = origin !== undefined && authorities.has(originAuthority(origin));
    if (origin !== undefined && !sameOrigin) {
      local(response, 403, { error: 'cross_origin' });
      return;
    }
    let url;
    try { url = new URL(request.url ?? '/', 'http://runner.invalid'); } catch {
      local(response, 400, { error: 'bad_path' });
      return;
    }
    if (clients && await localSource(response, () =>
      handleClientConnectionRequest({ request, response, url, system: clients }))) return;
    if (whoAnswers(url.pathname) === 'local') return void await own(request, response, url, sameOrigin);
    const host = store.host();
    const named = url.pathname.startsWith(REMOTE_PREFIX) ? namedHost(url.pathname, host) : null;
    if (named?.error) {
      local(response, named.status ?? 404, { error: named.error, message: 'This computer carries only the console of the '
        + 'host it is paired with. `fuli runner status` names it.' });
      return;
    }
    // A page of the host, asked for by the host's name: answered at the host's own path on this
    // origin, which the console's single page application reads (docs/runner-roles-design.md §5).
    if (named && wantsHtml(request)) {
      response.setHeader(SOURCE_HEADER, 'local');
      response.writeHead(302, { location: `${named.path}${url.search}` });
      response.end();
      return;
    }
    const path = named ? `${named.path}${url.search}` : (request.url ?? '/');
    const reached = host && !host.revokedAt ? await connection.connect() : null;
    if (!reached) return void await away(request, response, host, path);
    await relay(request, response, reached, path, host);
  }

  // This computer's own paths (whoAnswers): answered here, never by the host.
  async function own(request, response, url, sameOrigin) {
    if (url.pathname === STATUS_PATH) {
      const state = await status();
      local(response, 200, { kind: 'fuli-runner-console', pid, dataDir, version: FULI_VERSION,
        ...state, line: followerLine(state) });
      return;
    }
    if (url.pathname === BAND_PATH) {
      response.setHeader(SOURCE_HEADER, 'local');
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end(BAND_SOURCE);
      return;
    }
    if (url.pathname === SYNC_PATH) return void await syncNow(request, response, sameOrigin);
    if (url.pathname === ADDRESS_PATH) return void await addHostAddress(request, response, sameOrigin);
    if (url.pathname === PREPARE_PATH) return void prepareAgain(request, response, sameOrigin);
    await page(response);
  }

  // 「重新准备」: this computer's own runtime, prepared again in the background
  // (follower-local-runtime.js); answered at once with where it stands.
  function prepareAgain(request, response, sameOrigin) {
    if (request.method !== 'POST' || !sameOrigin) {
      local(response, 405, { error: 'post_from_this_console' });
      return;
    }
    let started = false;
    try { started = prepare({ dataDir, again: true }); } catch (error) {
      local(response, 500, { error: 'prepare_not_started', message: '没能开始准备本机运行时：'
        + `${String(error?.message ?? error).slice(0, 200)}。请再按一次「重新准备」。 / The preparation could not be started; press Prepare again.` });
      return;
    }
    const localRuntime = started ? { state: 'preparing', since: new Date().toISOString() } : readLocalRuntime(dataDir);
    local(response, 202, { started, localRuntime, runtimeLine: localRuntimeLine(localRuntime) });
  }

  // The follower's own page: what this computer follows, what runs where, and what waits.
  // Drawn at once from what is kept here (reachable not yet known): looking for
  // the host can take seconds while it is away, and the page's own script asks
  // and fills that in, saying meanwhile that it is looking (review of #1069).
  async function page(response, { requested = null } = {}) {
    const state = await status({ reach: false });
    response.setHeader(SOURCE_HEADER, 'local');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(followerConsolePage({ status: state, hostPath: hostPath(state.host), requested }));
  }

  // `现在重试`: delivers what waits now, and answers with this computer's new state.
  async function syncNow(request, response, sameOrigin) {
    // A write needs this computer's own page to have asked: a request with no Origin at all
    // is a program on this computer, which has `fuli runner sync`.
    if (request.method !== 'POST' || !sameOrigin) {
      local(response, 405, { error: 'post_from_this_console' });
      return;
    }
    const host = store.host();
    // Revoked is said as revoked, never as the host being away (review of #1069).
    const refusal = pairingRefusal(host);
    if (refusal) {
      local(response, refusal.status, refusal.body);
      return;
    }
    const reached = await connection.connect();
    if (!reached) {
      local(response, 503, { error: 'host_unreachable', message: `${host.name} 现在不在线，记录还在这里等着；它回来后会自动送出。`
        + ` / ${host.name} does not answer now; the records wait here and go once it answers.` });
      return;
    }
    const result = await deliver({ store, connection });
    const state = await status({ reach: false, reachable: true });
    local(response, 200, { delivered: result.delivered, refused: result.refused, queued: result.queued,
      html: outboxHtml(state.outbox), line: followerLine(state) });
  }

  // 「添加主机地址」: where the host is, when this computer cannot find it by
  // itself (the two are on one network but in different subnets, or on a VPN,
  // so mDNS does not carry). Only an address a host can be reached at on a LAN
  // or VPN, exactly what `fuli runner add-address` takes:
  // the paired certificate is checked there anyway, but no request of this
  // computer's is ever sent anywhere else.
  async function addHostAddress(request, response, sameOrigin) {
    if (request.method !== 'POST' || !sameOrigin) {
      local(response, 405, { error: 'post_from_this_console' });
      return;
    }
    if (!store.host()) {
      local(response, 503, { error: 'not_paired' });
      return;
    }
    let asked;
    try { asked = await readJson(request); } catch {
      local(response, 400, { error: 'invalid_json', message: '请求的内容读不懂。 / The request could not be read.' });
      return;
    }
    const address = String(asked?.address ?? '').trim();
    if (!isReachableHostAddress(address)) {
      local(response, 400, { error: 'not_a_private_address',
        message: '只填主机在局域网或 VPN 里的地址：10.x、172.16-31.x、192.168.x，或 Tailscale 这类工具给的 100.64-127.x。'
          + ' / The host\'s address on your LAN or VPN only: 10.x, 172.16-31.x, 192.168.x, or 100.64-127.x from Tailscale and the like.' });
      return;
    }
    store.learnHostAddresses([address]);
    connection.drop();
    const state = await status();
    local(response, 200, { reachable: state.host?.reachable ?? false, line: followerLine(state) });
  }

  // Marks an answer this computer gave itself, when it gave one.
  async function localSource(response, answer) {
    response.setHeader(SOURCE_HEADER, 'local');
    const handled = await answer();
    if (!handled) response.removeHeader(SOURCE_HEADER);
    return handled;
  }

  async function relay(request, response, reached, path, host) {
    const target = new URL(`${RUNNER_PATHS.console}${path}`, reached.origin);
    // `/../..` sent raw by a program on this computer would leave the console's prefix and reach the
    // host's other runner paths (`/runner/1/mcp`, `/replay`): only the console is carried.
    if (target.origin !== reached.origin || !target.pathname.startsWith(`${RUNNER_PATHS.console}/`)) {
      local(response, 400, { error: 'not_console_path' });
      return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_HEADERS.has(name)));
    if (request.headers.origin !== undefined) headers[SAME_ORIGIN_HEADER] = '1';
    // A page the band is added to is read as it is written: no compressed body to rewrite.
    if (wantsHtml(request)) headers['accept-encoding'] = 'identity';
    const upstream = httpsRequest(target, { method: request.method, agent: reached.agent, headers }, (answer) => {
      const outgoing = { ...Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP_HEADERS.has(name))),
        [SOURCE_HEADER]: 'host' };
      if (!bandable(answer)) {
        response.writeHead(answer.statusCode ?? 502, outgoing);
        answer.pipe(response);
        return;
      }
      collect(answer).then((body) => {
        const page = body === null ? null : withBand(body.toString('utf8'));
        if (page === null) {
          response.writeHead(answer.statusCode ?? 502, outgoing);
          response.end(body ?? undefined);
          return;
        }
        const bytes = Buffer.from(page, 'utf8');
        response.writeHead(answer.statusCode ?? 502, { ...outgoing, 'content-length': String(bytes.length) });
        response.end(bytes);
      }).catch(() => response.destroy());
    });
    upstream.on('error', () => {
      connection.drop();
      if (!response.headersSent) void away(request, response, host, path);
      else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  }

  // The host is away (or this computer was revoked): a page says so and shows
  // this computer's own console, which works without the host; an API call says
  // it plainly, as it always did.
  async function away(request, response, host, path) {
    if (!wantsHtml(request)) {
      response.setHeader(SOURCE_HEADER, 'unavailable');
      const refusal = pairingRefusal(host);
      sendJson(response, refusal?.status ?? 503, { ...(refusal?.body ?? { error: 'host_unreachable' }),
        outbox: store.outbox().queued });
      return;
    }
    const state = await status({ reach: false, reachable: false });
    response.setHeader(SOURCE_HEADER, 'unavailable');
    response.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
    response.end(followerConsolePage({ status: state, hostPath: hostPath(state.host), requested: path }));
  }

  await listenServer(server, port, '127.0.0.1');
  const bound = server.address().port;
  authorities = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  return { url: `http://127.0.0.1:${bound}`, close: () => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  }) };
}

// Not paired, or revoked: the answer for it, said as what it is. null while paired.
// The person acts on the host (a new invitation), then joins here; the page
// offers that command to copy, as nothing can be done with one click here.
const JOIN_AGAIN = { command: 'fuli runner invite',
  zh: '在主机上运行这条命令生成新邀请，再在这台电脑上运行它打印的 fuli runner join …。',
  en: 'Run this on the host for a new invitation, then run the `fuli runner join …` it prints on this computer.' };
function pairingRefusal(host) {
  if (!host) {
    return { status: 409, body: { error: 'not_paired', message: '这台电脑还没有跟随任何主机。 / This computer follows no host.',
      action: JOIN_AGAIN } };
  }
  if (!host.revokedAt) return null;
  return { status: 403, body: { error: 'runner_revoked',
    message: `${host.name} 已撤销这台电脑，记录不会再送出，直到重新加入同一台主机。`
      + ` / ${host.name} revoked this computer; nothing is sent until it joins the same host again.`,
    action: JOIN_AGAIN } };
}

// `/remote/<host>/<path>` → the path on that host, or why it reaches nothing.
// The name is the host's as this computer knows it (its own name, or the start
// of the fingerprint the pairing pinned); nothing else is ever reached.
function namedHost(pathname, host) {
  const [name, ...rest] = pathname.slice(REMOTE_PREFIX.length).split('/');
  let asked;
  try { asked = decodeURIComponent(name ?? '').toLowerCase(); } catch { return { error: 'bad_path', status: 400 }; }
  if (!host) return { error: 'not_paired' };
  if (!asked || ![hostSlug(host.name), host.name.toLowerCase(), host.fingerprint.slice(0, 16)].includes(asked)) {
    return { error: 'unknown_host' };
  }
  // One leading slash and no empty segments, as console-relay.js reads them on the host.
  return { path: `/${rest.filter(Boolean).join('/')}${rest.length > 1 && rest.at(-1) === '' ? '/' : ''}` };
}

function hostSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
}

function hostPath(host) {
  return host ? `${REMOTE_PREFIX}${encodeURIComponent(hostSlug(host.name))}/` : LOCAL_PATH;
}

function wantsHtml(request) {
  return String(request.headers.accept ?? '').includes('text/html');
}

// An HTML answer small enough to read as a whole, written as it is (not compressed).
function bandable(answer) {
  const encoding = String(answer.headers['content-encoding'] ?? '').toLowerCase();
  const length = Number(answer.headers['content-length'] ?? Number.NaN);
  return String(answer.headers['content-type'] ?? '').includes('text/html')
    && (!encoding || encoding === 'identity') && !(length > INJECT_LIMIT);
}

function collect(answer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    answer.on('data', (chunk) => {
      size += chunk.length;
      if (size > INJECT_LIMIT) { answer.destroy(); reject(new Error('page too large')); return; }
      chunks.push(chunk);
    });
    answer.on('end', () => resolve(Buffer.concat(chunks)));
    answer.on('error', reject);
  });
}

// The band goes last in the head, so the page's own styles are already there; a
// page without a head is left as it is.
function withBand(html) {
  const head = html.toLowerCase().indexOf('</head>');
  return head === -1 ? null : `${html.slice(0, head)}${bandTag()}${html.slice(head)}`;
}

function originAuthority(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' ? url.host.toLowerCase() : null;
  } catch {
    return null;
  }
}
