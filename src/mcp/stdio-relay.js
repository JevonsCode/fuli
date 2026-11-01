import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A client keeps the stdio server it started until the person restarts the
// session, so an update used to wait for every open session to restart. The
// client now starts this relay instead: it runs the installed version's server
// as a child and passes the JSON-RPC lines through unchanged. When a newer
// version is installed and no request is in flight, it starts the new server,
// replays the client's initialize handshake to it, retires the old one and
// tells the client the tool list may have changed. A new version that does not
// start keeps the old one running; the person notices nothing either way.
//
// The relay's own code stays the version the client started, so it must stay
// small: a later version only has to honour MCP_RELAYED_ENV.
export const MCP_RELAYED_ENV = 'FULI_MCP_RELAYED';

const CHECK_EVERY_MS = 30_000;
const READY_WITHIN_MS = 30_000;

// target() → { version, command, args } of the installed server, or null when
// it cannot be read (the running server then stays).
export function runStdioRelay({
  target,
  input = process.stdin,
  output = process.stdout,
  start = startServer,
  exit = code => process.exit(code ?? 1),
  checkEveryMs = CHECK_EVERY_MS,
  readyWithinMs = READY_WITHIN_MS
}) {
  const first = target();
  if (!first) throw new Error('The installed FULI MCP server cannot be found');
  const clientRequests = new Set();
  const serverRequests = new Set();
  const refused = new Set();
  let initialize = null, initialized = null, listChanged = false;
  let swapping = false, closing = false, queue = [];
  let current = attach(start(first), first.version);
  current.onLine = forward;

  function attach(child, version) {
    const server = { child, version, onLine: () => {} };
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => server.onLine(line));
    child.on('exit', code => { if (server === current) { closing = true; exit(code); } });
    return server;
  }

  function forward(line) {
    const message = parse(line);
    if (message && 'id' in message) {
      if (message.method) serverRequests.add(key(message.id));
      else {
        clientRequests.delete(key(message.id));
        if (initialize && key(message.id) === key(initialize.id) && !initialized) {
          listChanged = message.result?.capabilities?.tools?.listChanged === true;
        }
      }
    }
    output.write(`${line}\n`);
  }

  function fromClient(line) {
    if (swapping) { queue.push(line); return; }
    const message = parse(line);
    if (message?.method === 'initialize') initialize = { line, id: message.id };
    else if (message?.method === 'notifications/initialized') initialized = line;
    else if (initialized && idle()) {
      const next = newer();
      if (next) { queue.push(line); void swap(next); return; }
    }
    if (message && 'id' in message) {
      if (message.method) clientRequests.add(key(message.id));
      else serverRequests.delete(key(message.id));
    }
    current.child.stdin.write(`${line}\n`);
  }

  const idle = () => !swapping && !closing && clientRequests.size === 0 && serverRequests.size === 0;

  function newer() {
    let spec;
    try { spec = target(); } catch { return null; }
    return spec && spec.version !== current.version && !refused.has(spec.version) ? spec : null;
  }

  async function swap(spec) {
    swapping = true;
    let next;
    try {
      next = attach(start(spec), spec.version);
      await handshake(next);
      const retired = current;
      current = next;
      next.onLine = forward;
      retired.child.stdin.end();
      if (listChanged) output.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
    } catch {
      refused.add(spec.version);
      if (next) { next.onLine = () => {}; next.child.removeAllListeners('exit'); next.child.kill(); }
    } finally {
      swapping = false;
      const waiting = queue;
      queue = [];
      for (const line of waiting) fromClient(line);
    }
  }

  // Replays the client's handshake; the new server's answer stays with the relay.
  function handshake(server) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The new FULI MCP server did not start')), readyWithinMs);
      const fail = () => { clearTimeout(timer); reject(new Error('The new FULI MCP server exited')); };
      server.child.once('exit', fail);
      server.onLine = line => {
        const message = parse(line);
        if (!message || !('id' in message) || message.method || key(message.id) !== key(initialize.id)) return;
        clearTimeout(timer);
        server.child.off('exit', fail);
        if (message.error) { reject(new Error('The new FULI MCP server refused the client')); return; }
        server.child.stdin.write(`${initialized}\n`);
        resolve();
      };
      server.child.stdin.write(`${initialize.line}\n`);
    });
  }

  createInterface({ input, crlfDelay: Infinity }).on('line', fromClient);
  input.once('end', () => { closing = true; current.child.stdin.end(); });
  const timer = setInterval(() => {
    if (!initialized || !idle()) return;
    const next = newer();
    if (next) void swap(next);
  }, checkEveryMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function startServer({ command, args }) {
  return spawn(command, args, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, [MCP_RELAYED_ENV]: '1' },
    windowsHide: true
  });
}

function parse(line) {
  try {
    const message = JSON.parse(line);
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  } catch { return null; }
}

const key = id => JSON.stringify(id);
