import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// A client keeps the stdio server it started until the person restarts the
// session, so an update used to wait for every open session to restart. The
// client now starts this relay instead: it runs the installed version's server
// as a child and passes the JSON-RPC lines through unchanged. When a newer
// version is installed and no request is in flight, it starts the new server,
// replays the client's initialize handshake to it, retires the old one and
// tells the client the tool list may have changed. A new version that does not
// start leaves the old one serving. The relay can try the same update again
// after the next check interval.
//
// The relay's own code stays the version the client started, so it must stay
// small: a later version only has to honour MCP_RELAYED_ENV.
export const MCP_RELAYED_ENV = 'FULI_MCP_RELAYED';
// When the client's session began: the relay's start, which outlives any swap.
export const MCP_SESSION_STARTED_ENV = 'FULI_MCP_SESSION_STARTED';
const sessionStartedAt = new Date().toISOString();

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
  let failedUpdate = null;
  let canRepeatInitialize = true;
  let initialize = null, initialized = null, listChanged = false;
  let candidate = null, closing = false, queue = [];
  let current = serving(first);

  function serving(spec) {
    const server = attach(start(spec), spec.version);
    server.onLine = forward;
    return server;
  }

  // The installation can switch after the relay chooses its first child and
  // before that child reads its runtime. Only an unanswered initialize is safe
  // to repeat, once, against the replacement.
  function retryStartingClient() {
    if (closing || !canRepeatInitialize) return false;
    const replacement = newer();
    if (!replacement) return false;
    canRepeatInitialize = false;
    current.onLine = () => {};
    try { current = serving(replacement); } catch { return false; }
    if (initialize) current.child.stdin.write(`${initialize.line}\n`);
    return true;
  }

  function attach(child, version) {
    const server = { child, version, onLine: () => {}, onStop: null };
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => server.onLine(line));
    let stopped = false;
    function stop(code) {
      if (stopped) return;
      stopped = true;
      if (server === current) {
        if (retryStartingClient()) return;
        closing = true;
        candidate?.child.kill();
        exit(code);
      } else server.onStop?.();
    }
    child.once('close', stop);
    child.on('error', () => stop(1)); // A failed spawn does not emit exit.
    child.stdin.on('error', () => { child.kill(); stop(1); });
    return server;
  }

  function forward(line) {
    canRepeatInitialize = false;
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
    if (closing) return;
    if (candidate) { queue.push(line); return; }
    const message = parse(line);
    if (initialize || message?.method !== 'initialize') canRepeatInitialize = false;
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

  const idle = () => !candidate && !closing && clientRequests.size === 0 && serverRequests.size === 0;

  function newer() {
    let spec;
    try { spec = target(); } catch { return null; }
    if (!spec || spec.version === current.version) return null;
    if (spec.version === failedUpdate?.version && performance.now() < failedUpdate.retryAt) return null;
    return spec;
  }

  async function swap(spec) {
    try {
      candidate = attach(start(spec), spec.version);
      await handshake(candidate);
      if (closing) return;
      const retired = current;
      current = candidate;
      current.onLine = forward;
      retired.onLine = () => {};
      retired.child.stdin.end();
      failedUpdate = null;
      if (listChanged) output.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
    } catch {
      failedUpdate = { version: spec.version, retryAt: performance.now() + checkEveryMs };
    } finally {
      if (candidate && candidate !== current) {
        candidate.onLine = () => {};
        candidate.child.kill();
      }
      candidate = null;
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
      server.onStop = fail;
      server.onLine = line => {
        const message = parse(line);
        if (!message || !('id' in message) || message.method || key(message.id) !== key(initialize.id)) return;
        clearTimeout(timer);
        server.onStop = null;
        if (message.error) { reject(new Error('The new FULI MCP server refused the client')); return; }
        server.child.stdin.write(`${initialized}\n`);
        resolve();
      };
      server.child.stdin.write(`${initialize.line}\n`);
    });
  }

  createInterface({ input, crlfDelay: Infinity }).on('line', fromClient);
  input.once('end', () => { closing = true; candidate?.child.kill(); current.child.stdin.end(); });
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
    env: { ...process.env, [MCP_RELAYED_ENV]: '1', [MCP_SESSION_STARTED_ENV]: sessionStartedAt },
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
