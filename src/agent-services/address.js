import { connect } from 'node:net';

// A service's address, as an Agent reported it (a URL or host:port), and
// whether something listens there. Only addresses on this computer are
// probed: an address an Agent reported never makes FULI connect elsewhere.
const PROBE_TIMEOUT_MS = 700;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const DEFAULT_PORTS = Object.freeze({ 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 });

// { host, port } of a URL or host:port, or null.
function parseServiceAddress(address) {
  if (!address) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `tcp://${address}`);
    const port = Number(url.port || DEFAULT_PORTS[url.protocol]);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host && Number.isInteger(port) && port > 0 && port < 65536 ? { host, port } : null;
  } catch {
    return null;
  }
}

// 'open', 'closed', or 'not_checked' for an address elsewhere or one that cannot be read.
export async function probeServiceAddress(address) {
  const target = parseServiceAddress(address);
  if (!target || !(LOOPBACK_HOSTS.has(target.host) || /^127\./.test(target.host))) return 'not_checked';
  const host = ['0.0.0.0', 'localhost'].includes(target.host) ? '127.0.0.1' : target.host === '::' ? '::1' : target.host;
  return new Promise((resolve) => {
    const socket = connect({ host, port: target.port });
    const done = (state) => { socket.destroy(); resolve(state); };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done('closed'));
    socket.once('connect', () => done('open'));
    socket.once('error', () => done('closed'));
  });
}
