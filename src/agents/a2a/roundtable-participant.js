import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

const OUTPUT_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;

class A2AParticipantError extends Error {
  constructor(code, status = null) {
    const messages = {
      invalid_endpoint: 'A2A requires an explicitly configured public HTTPS endpoint on one origin.',
      waiting_auth: 'Remote A2A authentication or permission is required.',
      waiting_input: 'The remote A2A participant requires additional input.',
      unsupported_protocol: 'The remote agent does not advertise a supported A2A protocol interface.',
      response_invalid: 'The remote A2A participant returned an invalid or mismatched result.',
      response_too_large: 'The remote A2A response exceeds the transport limit.',
      output_too_large: 'The remote A2A output exceeds the roundtable message limit.',
      remote_failed: 'The remote A2A task or request failed.',
      cancelled: 'The remote A2A turn was interrupted.',
      timeout: 'The remote A2A turn timed out.',
      participant_busy: 'The A2A participant already has a running turn.',
      participant_closed: 'The A2A participant is closed.'
    };
    super(messages[code] ?? messages.remote_failed);
    this.code = code;
    if (status !== null) this.status = status;
  }
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && [18, 19].includes(b));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const embedded = normalized.slice(7);
      return isIP(embedded) === 4 && publicAddress(embedded);
    }
    // Global unicast only; reject loopback, ULA, link-local and multicast.
    return /^[23][0-9a-f]{0,3}:/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}

function endpointUrl(value) {
  let target;
  try { target = new URL(value); } catch { throw new A2AParticipantError('invalid_endpoint'); }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (target.protocol !== 'https:' || target.username || target.password || target.hash ||
      /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(hostname) ||
      (!isIP(hostname) && !hostname.includes('.')) || (isIP(hostname) && !publicAddress(hostname))) {
    throw new A2AParticipantError('invalid_endpoint');
  }
  return target;
}

function redact(value, secret) {
  return secret && typeof value === 'string' ? value.replaceAll(secret, '[REDACTED_SECRET]') : value;
}

function boundedText(value, secret, trim = true) {
  const text = redact(typeof value === 'string' ? value : '', secret);
  const result = trim ? text.trim() : text;
  if (Buffer.byteLength(result, 'utf8') > OUTPUT_LIMIT) throw new A2AParticipantError('output_too_large');
  return result;
}

function identifier(value, secret) {
  const text = boundedText(value, secret);
  if (!text || text.length > 256 || (secret && value.includes(secret))) throw new A2AParticipantError('response_invalid');
  return text;
}

async function abortableLookup(lookupImpl, hostname, signal) {
  signal?.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([lookupImpl(hostname, { all: true, verbatim: true }), aborted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function partsText(parts) {
  return (parts ?? []).filter((part) => part.content?.$case === 'text')
    .map((part) => part.content.value).join('\n');
}

function usageFromMetadata(metadata) {
  const value = metadata?.usage;
  const count = (number) => Number.isSafeInteger(number) && number >= 0 ? number : null;
  const totalTokens = count(value?.totalTokens ?? value?.total_tokens);
  if (totalTokens === null) return null;
  return { source: 'executor', totalTokens, inputTokens: count(value.inputTokens ?? value.input_tokens),
    outputTokens: count(value.outputTokens ?? value.output_tokens), cachedInputTokens: null,
    cacheWriteInputTokens: null, reasoningOutputTokens: null };
}

function limitedResponse(response) {
  if (!response.body) throw new A2AParticipantError('response_invalid');
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new A2AParticipantError('response_too_large');
      controller.enqueue(chunk);
    }
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function pinnedHttpsFetch(target, init, addresses, requestImpl) {
  return new Promise((resolve, reject) => {
    const request = requestImpl(target, {
      method: init.method ?? 'GET', signal: init.signal,
      headers: Object.fromEntries(init.headers),
      lookup(_hostname, options, callback) {
        const matching = addresses.filter((entry) => !options.family || entry.family === options.family);
        if (!matching.length) return callback(new A2AParticipantError('invalid_endpoint'));
        if (options.all) callback(null, matching);
        else callback(null, matching[0].address, matching[0].family);
      }
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) headers.append(name, item);
        }
      }
      const bodyless = [204, 205, 304].includes(incoming.statusCode);
      if (bodyless) incoming.resume();
      resolve(new Response(bodyless ? null : Readable.toWeb(incoming), {
        status: incoming.statusCode, statusText: incoming.statusMessage, headers
      }));
    });
    request.on('error', reject);
    request.end(init.body);
  });
}

/** A2A SDK client adapter. Remote completion is a turn result, not Fuli task verification. */
export function createA2AParticipant({
  url,
  env = process.env,
  fetchImpl,
  lookupImpl = lookup,
  httpsRequestImpl = httpsRequest,
  cardPath = '/.well-known/agent-card.json',
  legacyCompat = false,
  timeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 500
} = {}) {
  const secret = typeof env.FULI_A2A_TOKEN === 'string' ? env.FULI_A2A_TOKEN.trim() : '';
  let client = null;
  let sdk = null;
  let card = null;
  let contextId = '';
  let pendingTaskId = '';
  let active = null;
  let closed = false;

  async function safeFetch(input, init = {}) {
    const configured = endpointUrl(url);
    const target = endpointUrl(input instanceof Request ? input.url : String(input));
    if (target.origin !== configured.origin) throw new A2AParticipantError('invalid_endpoint');
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    let addresses = [{ address: hostname, family: isIP(hostname) }];
    if (!isIP(hostname)) {
      addresses = await abortableLookup(lookupImpl, hostname, init.signal);
      if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) {
        throw new A2AParticipantError('invalid_endpoint');
      }
    }
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    if (secret) headers.set('Authorization', `Bearer ${secret}`);
    const requestInit = { ...init, headers, redirect: 'error' };
    // The default transport uses the validated DNS answer rather than resolving again at connection time.
    const response = fetchImpl && fetchImpl !== globalThis.fetch
      ? await fetchImpl(target, requestInit)
      : await pinnedHttpsFetch(target, requestInit, addresses, httpsRequestImpl);
    if (response.redirected || (response.url && new URL(response.url).origin !== configured.origin)) {
      await response.body?.cancel();
      throw new A2AParticipantError('invalid_endpoint');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new A2AParticipantError([401, 403].includes(response.status) ? 'waiting_auth' : 'remote_failed', response.status);
    }
    return limitedResponse(response);
  }

  function safeFailure(error, signal) {
    if (signal?.aborted) return new A2AParticipantError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
    return error instanceof A2AParticipantError ? error : new A2AParticipantError('remote_failed');
  }

  async function connect(signal) {
    if (closed) throw new A2AParticipantError('participant_closed');
    endpointUrl(url);
    if (secret && /[\r\n]/.test(secret)) throw new A2AParticipantError('waiting_auth');
    const response = await safeFetch(new URL(cardPath, url), { signal, headers: { 'A2A-Version': '1.0' } });
    const rawCard = await response.json();
    const [protocol, clients] = await Promise.all([import('@a2a-js/sdk'), import('@a2a-js/sdk/client')]);
    sdk = protocol;
    const resolver = new clients.DefaultAgentCardResolver({ legacyCompat: { enabled: legacyCompat } });
    card = resolver.normalizeAgentCard(rawCard);
    if (!card.supportedInterfaces?.length) throw new A2AParticipantError('unsupported_protocol');
    for (const entry of card.supportedInterfaces) {
      if (endpointUrl(entry.url).origin !== endpointUrl(url).origin) throw new A2AParticipantError('invalid_endpoint');
    }
    const compatible = card.supportedInterfaces.filter((entry) =>
      ['JSONRPC', 'HTTP+JSON'].includes(entry.protocolBinding.toUpperCase()) &&
      (/^1\.0(?:\.0)?$/.test(entry.protocolVersion) || (legacyCompat && /^0\.3(?:\.\d+)?$/.test(entry.protocolVersion))));
    if (!compatible.length) throw new A2AParticipantError('unsupported_protocol');
    if (card.securityRequirements?.length && !secret) throw new A2AParticipantError('waiting_auth');
    const factory = new clients.ClientFactory({
      transports: [new clients.JsonRpcTransportFactory({ fetchImpl: safeFetch, legacyCompat: { enabled: legacyCompat } }),
        new clients.RestTransportFactory({ fetchImpl: safeFetch, legacyCompat: { enabled: legacyCompat } })],
      clientConfig: { polling: true, acceptedOutputModes: ['text/plain'] }, cardResolver: resolver
    });
    client = await factory.createFromAgentCard({ ...card, supportedInterfaces: compatible });
  }

  return {
    describe() {
      return { applicationLabel: 'A2A', automatic: true, workspaceWrite: false, cancel: 'remote_request', reportsUsage: false };
    },
    async preflight({ signal } = {}) {
      const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      try {
        if (active) throw new A2AParticipantError('participant_busy');
        await connect(boundedSignal);
        return { ready: true, applicationLabel: 'A2A', name: boundedText(card.name, secret),
          protocolVersion: client.protocolVersion, streaming: Boolean(card.capabilities?.streaming), evidence: 'agent_card_discovery' };
      } catch (error) {
        if (!active) client = null;
        const failure = safeFailure(error, boundedSignal);
        return { ready: false, code: failure.code, reason: failure.message };
      }
    },
    async dispatch({ prompt, signal, turn } = {}) {
      if (closed) throw new A2AParticipantError('participant_closed');
      if (active) throw new A2AParticipantError('participant_busy');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new A2AParticipantError('response_invalid');
      const controller = new AbortController();
      const boundedSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      active = controller;
      let remoteTaskId = '';
      let cancellation = null;
      let task = null;
      let message = null;
      let eventCount = 0;
      const artifacts = new Map();
      const actualRecord = () => {
        if (!remoteTaskId && !message?.messageId) return null;
        const metadata = message?.metadata ?? task?.metadata;
        const model = typeof metadata?.model === 'string' && metadata.model.length <= 256
          ? redact(metadata.model, secret) : null;
        return { sourceApplication: 'other', applicationLabel: 'A2A', provider: 'a2a', model,
          sessionId: identifier(contextId || remoteTaskId || message?.messageId, secret),
          remoteTaskId: remoteTaskId ? identifier(remoteTaskId, secret) : null,
          usage: usageFromMetadata(metadata), evidence: 'remote_protocol_response' };
      };
      const requestCancellation = () => {
        if (!remoteTaskId || !client) return Promise.resolve(false);
        cancellation ??= client.cancelTask({ id: remoteTaskId, tenant: '' }, { signal: AbortSignal.timeout(5000) })
          .then((result) => result.id === remoteTaskId && result.status?.state === sdk.TaskState.TASK_STATE_CANCELED)
          .catch(() => false);
        return cancellation;
      };
      const onAbort = () => { void requestCancellation(); };
      boundedSignal.addEventListener('abort', onAbort, { once: true });
      const capture = (value) => {
        if (value.messageId) {
          if (value.role !== sdk.Role.ROLE_AGENT) throw new A2AParticipantError('response_invalid');
          identifier(value.messageId, secret);
          if ((value.taskId && remoteTaskId && value.taskId !== remoteTaskId) ||
              (value.contextId && contextId && value.contextId !== contextId)) {
            throw new A2AParticipantError('response_invalid');
          }
          if (value.contextId) contextId = identifier(value.contextId, secret);
          if (value.taskId) remoteTaskId = identifier(value.taskId, secret);
          message = value;
          boundedSignal.throwIfAborted();
          return;
        }
        const id = value.id ?? value.taskId;
        if (!id || (remoteTaskId && remoteTaskId !== id)) throw new A2AParticipantError('response_invalid');
        remoteTaskId = identifier(id, secret);
        if (value.contextId && contextId && value.contextId !== contextId) throw new A2AParticipantError('response_invalid');
        if (value.contextId) contextId = identifier(value.contextId, secret);
        task = { ...task, ...value, id, status: value.status ?? task?.status };
        for (const artifact of value.artifacts ?? (value.artifact ? [value.artifact] : [])) {
          if (!artifact.artifactId || artifacts.size >= 32 && !artifacts.has(artifact.artifactId)) {
            throw new A2AParticipantError('response_invalid');
          }
          const previous = artifacts.get(artifact.artifactId);
          const text = `${value.append ? previous?.text ?? '' : ''}${partsText(artifact.parts)}`;
            const name = boundedText(artifact.name, secret);
            artifacts.set(artifact.artifactId, { artifactId: identifier(artifact.artifactId, secret),
              ...(name.trim() ? { name } : {}), text: boundedText(text, secret, false) });
        }
        boundedSignal.throwIfAborted();
      };
      try {
        if (!client) await connect(boundedSignal);
        boundedSignal.throwIfAborted();
        const params = sdk.SendMessageRequest.fromJSON({
          message: { messageId: randomUUID(), role: 'ROLE_USER', contextId, taskId: pendingTaskId,
            parts: [{ text: prompt }], metadata: { fuli: { turnId: turn?.id ?? turn?.turnId ?? null, attemptId: turn?.attemptId ?? null } } },
          configuration: { acceptedOutputModes: ['text/plain'], historyLength: 8, returnImmediately: true }
        });
        if (card.capabilities?.streaming) {
          for await (const event of client.sendMessageStream(params, { signal: boundedSignal })) {
            if (++eventCount > 512 || !event.payload) throw new A2AParticipantError('response_invalid');
            capture(event.payload.value);
            if (task?.status && ![sdk.TaskState.TASK_STATE_SUBMITTED, sdk.TaskState.TASK_STATE_WORKING,
              sdk.TaskState.TASK_STATE_UNSPECIFIED].includes(task.status.state)) break;
            if (message && !remoteTaskId) break;
          }
        } else capture(await client.sendMessage(params, { signal: boundedSignal }));
        while ([sdk.TaskState.TASK_STATE_SUBMITTED, sdk.TaskState.TASK_STATE_WORKING].includes(task?.status?.state)) {
          await delay(pollIntervalMs, undefined, { signal: boundedSignal });
          capture(await client.getTask({ id: remoteTaskId, tenant: '', historyLength: 8 }, { signal: boundedSignal }));
        }
        const state = task?.status?.state;
        if (state === sdk.TaskState.TASK_STATE_INPUT_REQUIRED || state === sdk.TaskState.TASK_STATE_AUTH_REQUIRED) {
          pendingTaskId = remoteTaskId;
          const failure = new A2AParticipantError(state === sdk.TaskState.TASK_STATE_INPUT_REQUIRED ? 'waiting_input' : 'waiting_auth');
          failure.body = boundedText(partsText(task.status.message?.parts), secret);
          failure.remoteTaskId = identifier(remoteTaskId, secret);
          throw failure;
        }
        if ((!message || task) && state !== sdk.TaskState.TASK_STATE_COMPLETED) throw new A2AParticipantError('remote_failed');
        const statusMessage = task?.status?.message?.role === sdk.Role.ROLE_AGENT ? task.status.message : null;
        const latestMessage = message ?? statusMessage ?? [...(task?.history ?? [])].reverse().find((item) => item.role === sdk.Role.ROLE_AGENT);
        const artifactText = [...artifacts.values()].map((item) => item.text).filter(Boolean).join('\n');
        const body = boundedText(artifactText || partsText(latestMessage?.parts), secret);
        if (!body) throw new A2AParticipantError('response_invalid');
        pendingTaskId = '';
        return { body, actual: actualRecord(), artifacts: [...artifacts.values()] };
      } catch (error) {
        const failure = safeFailure(error, boundedSignal);
        const actual = actualRecord();
        if (actual) failure.actual = actual;
        if (boundedSignal.aborted) {
          failure.cancellationConfirmed = await requestCancellation();
          failure.remoteTaskId = remoteTaskId ? identifier(remoteTaskId, secret) : null;
        }
        throw failure;
      } finally {
        boundedSignal.removeEventListener('abort', onAbort);
        active = null;
      }
    },
    async close() {
      closed = true;
      active?.abort();
    }
  };
}
