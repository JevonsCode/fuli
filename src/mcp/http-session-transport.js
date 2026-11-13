import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// The sessions of a streamable HTTP MCP endpoint, behind whatever already
// authenticated the request: one transport and MCP server per session, a
// session limit, idle eviction, in-flight tracking and a graceful close.
// Each session belongs to the owner that initialized it (a remote connector,
// one guest link); a request names its owner and never reaches another
// owner's session, and closeOwner ends every session of one owner at once.
// The remote MCP connector (remote-http-server.js) and the guest link
// listener (src/guest-access) share it.
const MAX_REQUEST_BYTES = 1024 * 1024;

export function createHttpSessionTransport({ label, maxSessions, sessionIdleTtlMs, sessionSweepIntervalMs, now }) {
  const sessions = new Map();
  const pendingSessions = new Set();
  let closeStarted = false;
  const isClosing = () => closeStarted;
  const sweepTimer = setInterval(() => {
    evictIdleSessions(sessions, now() - sessionIdleTtlMs);
  }, sessionSweepIntervalMs);
  sweepTimer.unref?.();

  const ownedSession = (sessionId, owner) => {
    const entry = sessionId ? sessions.get(sessionId) ?? null : null;
    return entry?.owner === owner ? entry : null;
  };

  // An authenticated MCP request of owner; createMcp() builds the MCP server
  // of a new session.
  async function handle(request, response, { owner, createMcp }) {
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
      response.writeHead(405, { allow: 'GET, POST, DELETE' }).end();
      return;
    }
    if (isClosing()) {
      sendJsonRpcError(response, 503, -32000, `${label} is closing`);
      return;
    }

    const sessionId = singleHeader(request.headers['mcp-session-id']);
    let entry = ownedSession(sessionId, owner);
    if (request.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof RequestTooLargeError) {
          response.once('finish', () => request.destroy());
          sendJsonRpcError(response, 413, -32600, 'Request too large', {
            closeConnection: true
          });
          return;
        }
        if (error instanceof SyntaxError) {
          sendJsonRpcError(response, 400, -32700, 'Parse error');
          return;
        }
        throw error;
      }
      // Reading a streamed body yields control. Shutdown may have started while the
      // client was still uploading, so re-check before allocating a session.
      if (isClosing()) {
        sendJsonRpcError(response, 503, -32000, `${label} is closing`, {
          closeConnection: true
        });
        return;
      }
      // A streamed body yields long enough for the idle sweeper to retire an
      // existing session. Re-resolve it before dispatch; the in-flight counter is
      // incremented synchronously from here, so the sweeper cannot win again.
      if (sessionId) entry = ownedSession(sessionId, owner);
      if (!entry && !sessionId && isInitializeRequest(body)) {
        evictIdleSessions(sessions, now() - sessionIdleTtlMs);
        if (sessions.size + pendingSessions.size >= maxSessions) {
          sendJsonRpcError(response, 503, -32000, `${label} session limit reached`);
          return;
        }
        entry = createSession({ owner, mcp: createMcp(), sessions, pendingSessions, isClosing, now });
        pendingSessions.add(entry);
        try {
          await entry.mcp.connect(entry.transport);
          if (isClosing()) {
            sendJsonRpcError(response, 503, -32000, `${label} is closing`, {
              closeConnection: true
            });
            return;
          }
          await handleSessionRequest(
            entry,
            request,
            response,
            body,
            now,
            true,
            (delivered) => {
              if (delivered || isClosing()) return;
              pendingSessions.delete(entry);
              if (entry.sessionId) sessions.delete(entry.sessionId);
              void closeSession(entry);
            }
          );
        } finally {
          if (!entry.transport.sessionId || isClosing()) {
            pendingSessions.delete(entry);
            if (entry.sessionId) sessions.delete(entry.sessionId);
            // Once shutdown starts, close() owns this snapshotted entry and waits
            // for its tracked response before closing the transport.
            if (!isClosing()) await closeSession(entry);
          }
        }
        return;
      }
      if (!entry) {
        sendJsonRpcError(response, sessionId ? 404 : 400, -32000, 'Invalid or missing MCP session');
        return;
      }
      await handleSessionRequest(entry, request, response, body, now, true);
      return;
    }
    if (!entry) {
      sendJsonRpcError(response, sessionId ? 404 : 400, -32000, 'Invalid or missing MCP session');
      return;
    }
    // A silent standalone SSE stream is not application activity. Leaving it
    // outside inFlight lets the idle TTL reclaim authenticated clients that pin
    // session slots without making requests. DELETE is likewise terminal control.
    await handleSessionRequest(entry, request, response, undefined, now, false);
  }

  return {
    handle,
    isClosing,
    stats: () => ({
      activeSessions: sessions.size,
      pendingSessions: pendingSessions.size,
      closing: closeStarted
    }),
    // Ends every session of owner now, open streams included.
    closeOwner(owner) {
      const owned = [...sessions.values(), ...pendingSessions].filter((entry) => entry.owner === owner);
      for (const entry of owned) {
        pendingSessions.delete(entry);
        if (entry.sessionId) sessions.delete(entry.sessionId);
      }
      return Promise.all(owned.map(closeSession));
    },
    // Refuses new requests, waits until deadline (a Date.now() instant) for
    // tracked requests to finish, then closes every session.
    async close(deadline) {
      closeStarted = true;
      clearInterval(sweepTimer);
      const entries = [...new Set([
        ...sessions.values(),
        ...pendingSessions.values()
      ])];
      sessions.clear();
      pendingSessions.clear();
      await waitForInFlightRequests(entries, deadline);
      await waitForPromiseWithinDeadline(
        Promise.all(entries.map(closeSession)),
        deadline
      );
    }
  };
}

function createSession({ owner, mcp, sessions, pendingSessions, isClosing, now }) {
  let entry;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (sessionId) => {
      pendingSessions.delete(entry);
      entry.sessionId = sessionId;
      entry.lastSeen = now();
      if (isClosing()) {
        // close() already snapshotted pending entries synchronously. It will
        // close this transport after any tracked initialization response drains.
        return;
      }
      sessions.set(sessionId, entry);
    }
  });
  entry = {
    owner,
    transport,
    mcp,
    closing: null,
    sessionId: null,
    lastSeen: now(),
    inFlight: 0,
    drainListeners: new Set()
  };
  transport.onclose = () => {
    pendingSessions.delete(entry);
    if (entry.sessionId) sessions.delete(entry.sessionId);
    void closeSession(entry);
  };
  return entry;
}

function singleHeader(value) {
  return typeof value === 'string' ? value : null;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        request.pause();
        settle(() => reject(new RequestTooLargeError()));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => settle(() => {
      if (!chunks.length) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    const onError = (error) => settle(() => reject(error));
    const onAborted = () => settle(() => reject(new Error('Request body was aborted')));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

class RequestTooLargeError extends Error {}

export function sendJsonRpcError(response, status, code, message, { closeConnection = false } = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(closeConnection ? { connection: 'close' } : {})
  });
  response.end(body);
}

async function handleSessionRequest(
  entry,
  request,
  response,
  body,
  now,
  trackInFlight,
  onSettled = null
) {
  if (!trackInFlight) {
    await entry.transport.handleRequest(request, response, body);
    return;
  }

  entry.inFlight += 1;
  let handlerFinished = false;
  let responseFinished = false;
  let responseDelivered = false;
  let released = false;
  const release = () => {
    if (released || !handlerFinished || !responseFinished) return;
    released = true;
    response.off('finish', onResponseFinish);
    response.off('close', onResponseClose);
    entry.inFlight -= 1;
    if (responseDelivered) entry.lastSeen = now();
    onSettled?.(responseDelivered);
    if (entry.inFlight === 0) {
      for (const listener of entry.drainListeners) listener();
    }
  };
  const markResponseFinished = (delivered) => {
    if (!responseFinished) {
      responseFinished = true;
      responseDelivered = delivered;
    }
    release();
  };
  const onResponseFinish = () => markResponseFinished(true);
  const onResponseClose = () => markResponseFinished(response.writableFinished);
  response.once('finish', onResponseFinish);
  response.once('close', onResponseClose);
  if (response.writableFinished) onResponseFinish();
  else if (response.destroyed || response.closed) onResponseClose();
  try {
    await entry.transport.handleRequest(request, response, body);
  } finally {
    handlerFinished = true;
    release();
  }
}

function waitForInFlightRequests(entries, deadline) {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0 || entries.every((entry) => entry.inFlight === 0)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const entry of entries) entry.drainListeners.delete(check);
      resolve();
    };
    const check = () => {
      if (entries.every((entry) => entry.inFlight === 0)) finish();
    };
    for (const entry of entries) entry.drainListeners.add(check);
    timer = setTimeout(finish, remainingMs);
    check();
  });
}

async function waitForPromiseWithinDeadline(promise, deadline) {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) return false;
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function evictIdleSessions(sessions, cutoff) {
  for (const [sessionId, entry] of sessions) {
    if (entry.inFlight > 0 || entry.lastSeen > cutoff) continue;
    sessions.delete(sessionId);
    void closeSession(entry);
  }
}

function closeSession(entry) {
  if (!entry.closing) {
    entry.closing = Promise.allSettled([
      Promise.resolve().then(() => entry.mcp.close()),
      Promise.resolve().then(() => entry.transport.close())
    ]).then(() => undefined);
  }
  return entry.closing;
}
