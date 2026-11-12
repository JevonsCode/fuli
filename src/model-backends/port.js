import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFetch } from './model-fetch.js';

import { MODEL_ADAPTERS } from './adapters/registry.js';
import { budgetBlock, callLimits, ceilingCost, estimateCost, estimateTokens, roundCost, windowStart } from './budget.js';
import { MODEL_BACKEND_ROLES, SEMANTIC_ROLE, configRevision, connectionHealthIdentity, connectionIdentity } from './config.js';
import { decisionContract, decisionEnvelope } from './decision-contract.js';
import { egressAllowed } from './egress.js';
import { CONNECTIVITY_REASONS, FAILURE_STATUS, isFallbackEligible, modelFailure } from './failures.js';
import { decisionPrompt, promptForMode, repairTurns } from './prompt.js';
import {
  CONNECTION_CHECK, connectionCheckRequest, embeddingCheckRequest, embeddingEgress, parseDecisionRequest, parseEmbeddingRequest,
  parseUsageQuery
} from './request.js';
import { reportedUsage } from './usage.js';

// The shared model port of the four built-in Agents (rec#8, D-04), and of
// the person's semantic search model (rec#88), which only embeds. It owns
// configuration, egress, budget, bounded retry and repair, strict output
// validation and the usage ledger; protocol differences stay in adapters.
// It returns the compact decision envelope and a model receipt; it never
// executes the decision and never falls back by itself. When a role is not
// configured, the caller keeps the work in the current session.

const TRANSIENT_RETRY_LIMIT = 1;
const REPAIR_LIMIT = 1;
const BASE_BACKOFF_MS = 1000;
const MIN_ATTEMPT_MS = 1000;
// A live attempt aborts at its timeout; a reservation still unsettled this
// long after that belongs to a process that stopped before settling it.
const RESERVATION_GRACE_MS = 60_000;
// rec#10 D-32: the local build is read once after a valid answer, within
// what is left of that attempt's deadline and never longer than this; with
// less left than LOCAL_BUILD_MIN_MS it is not read at all.
const LOCAL_BUILD_MAX_MS = 2000;
const LOCAL_BUILD_MIN_MS = 100;

const USAGE_NOTES = 'One record per actual model API attempt; requests count distinct requestIds. '
  + 'reported is null when no attempt reported that value: unknown, never 0. '
  + 'cachedInput, cacheWriteInput and reasoning are subsets of input or output as each provider defines them and are never added to totals. '
  + 'unreportedAttempts returned no token counts at all; failedRequests are calls no attempt answered. '
  + 'Usage carries no cost; a budget cost is an estimate from configured unit prices only.';

// Why a saved key was not used; anything else the store refuses is secret_unreadable.
const KEY_REFUSALS = Object.freeze({ secret_store_insecure: 'secret_store_insecure',
  secret_endpoint_mismatch: 'key_endpoint_mismatch', secret_endpoint_unbound: 'key_endpoint_mismatch' });

// builtinEmbed({ model, texts, signal }): the local graph service's own model
// (adapters/builtin-embeddings.js); null where there is none.
export function createModelBackendPort({ readConfig, secrets, ledger, fetchImpl = modelFetch, wait = delay,
  now = () => new Date(), timeoutSignal = ms => AbortSignal.timeout(ms), builtinEmbed = null }) {
  // Endpoints that rejected json_schema output, for this process.
  const promptOnly = new Set();

  // What every call needs before its first attempt: the role's enabled
  // settings for this operation, its connection and adapter, the egress
  // approval and the key, kept on the call. Answers { stop } with the result
  // that ends the call, or { adapter, secret }.
  async function prepare(request, call, { approved }) {
    const loaded = readConfig();
    if (loaded.state === 'absent') return { stop: call.notConfigured('no_config') };
    if (loaded.state === 'invalid') return { stop: call.stop('configuration', 'invalid_config') };
    call.roleConfig = loaded.config.roles[request.role] ?? null;
    if (!call.roleConfig) return { stop: call.notConfigured('role_not_configured') };
    if (!call.roleConfig.enabled) return { stop: call.notConfigured('role_disabled') };
    if (request.operation !== CONNECTION_CHECK && !call.roleConfig.allowedOperations.includes(request.operation)) {
      return { stop: call.notConfigured('operation_not_allowed') };
    }
    call.target = { id: call.roleConfig.connection, ...loaded.config.connections[call.roleConfig.connection] };
    const adapter = MODEL_ADAPTERS[call.target.protocol];
    if (!approved.supports(adapter)) return { stop: call.stop('configuration', 'unsupported_output') };
    // A model on this computer sends nothing out, so no project needs approving for it.
    if (!adapter.local && !approved.egress(call.roleConfig.egress)) return { stop: call.stop('refusal', 'egress_not_approved') };
    if (!call.target.secretRef) return { adapter, secret: null };
    let secret;
    try {
      // Only for the origin the key was saved for (secret-store.js).
      secret = await secrets.read(call.target.secretRef, call.target.endpoint);
    } catch (error) {
      return { stop: call.stop('configuration', KEY_REFUSALS[error?.code] ?? 'secret_unreadable') };
    }
    return secret ? { adapter, secret } : { stop: call.stop('configuration', 'missing_key') };
  }

  // The receipt of one call and the results that end it. empty is the
  // result without an answer, to which each ending adds its receipt.
  function callRecord(empty) {
    const call = { startedAt: now().getTime(), attempts: [], target: null, roleConfig: null, mode: null, reportedConfidence: null };
    call.receipt = (status, { reason = null, failure = null } = {}) => {
      const { target, attempts } = call;
      const fallbackEligible = failure ? isFallbackEligible(failure, call.roleConfig) : false;
      return {
        backend: 'model_api', status, reason: failure?.reason ?? reason, failureClass: failure?.failureClass ?? null,
        fallbackEligible, fallbackReason: fallbackEligible ? failure.reason : null,
        connection: target?.id ?? null, protocol: target?.protocol ?? null, requestedModel: target?.model ?? null,
        // Which configured connection was asked (config.js connectionIdentity); a role's trust gate compares it.
        connectionIdentity: target ? connectionIdentity(target.id, target) : null,
        actualModel: attempts.findLast(attempt => attempt.actualModel)?.actualModel ?? null,
        outputMode: attempts.length ? call.mode : null, attempts: attempts.length, usage: receiptUsage(attempts),
        reportedConfidence: call.reportedConfidence, durationMs: now().getTime() - call.startedAt
      };
    };
    call.notConfigured = reason => ({ ...empty, modelReceipt: call.receipt('not_configured', { reason }) });
    call.fail = failure => ({ ...empty, modelReceipt: call.receipt(FAILURE_STATUS[failure.failureClass], { failure }) });
    call.stop = (failureClass, reason) => call.fail(modelFailure(failureClass, reason));
    return call;
  }

  // An attempt as the ledger keeps it before it goes out: metadata only,
  // never prompt text, texts or vectors. Reserves its ceiling in the role's
  // window and answers the reason it may not start, or null.
  function reserveAttempt(request, call, { purpose, inputTokens, maxOutputTokens, remainingMs }) {
    const { target, roleConfig } = call;
    const attemptStarted = now();
    const pending = {
      requestId: request.requestId, attemptId: randomUUID(), attemptNumber: call.attempts.length + 1, purpose, channel: 'model_api',
      role: request.role, operation: request.operation, personalSpaceId: request.scope.personalSpaceId,
      personalProjectId: request.scope.personalProjectId, connectionId: target.id,
      healthIdentity: connectionHealthIdentity(target.id, target), protocol: target.protocol,
      endpointHost: new URL(target.endpoint).host, endpoint: target.endpoint, requestedModel: target.model, outputMode: call.mode,
      startedAt: attemptStarted.toISOString(), budgetCeilingTokens: inputTokens + maxOutputTokens,
      costCurrency: target.pricing?.currency ?? null
    };
    const blocked = ledger.reserve({ attempt: pending, ceilingCost: ceilingCost(target.pricing, inputTokens, maxOutputTokens),
      expiresAt: new Date(attemptStarted.getTime() + remainingMs + RESERVATION_GRACE_MS).toISOString(),
      since: windowStart(roleConfig.budget, attemptStarted), now: attemptStarted.toISOString(),
      check: window => budgetBlock({ budget: roleConfig.budget, pricing: target.pricing, window,
        estimatedInputTokens: inputTokens, maxOutputTokens }) });
    return { pending, attemptStarted, blocked };
  }

  async function run(request) {
    const call = callRecord({ envelope: null });
    const { stop, fail } = call;
    const prepared = await prepare(request, call, { approved: {
      supports: adapter => adapter.supports(request), egress: egress => egressAllowed(request, egress) } });
    if (prepared.stop) return prepared.stop;
    const { adapter, secret } = prepared;
    const { target, roleConfig, attempts, startedAt } = call;

    const contract = decisionContract(request);
    const prompt = decisionPrompt(request, contract.providerSchema);
    const limits = callLimits(roleConfig.budget, request.budget);
    const deadline = startedAt + limits.timeoutMs;
    const formatKey = `${target.protocol} ${target.endpoint} ${target.model}`;
    call.mode = adapter.outputMode === 'json_schema' && promptOnly.has(formatKey) ? 'prompt' : adapter.outputMode;
    let turns = prompt.turns;
    let purpose = 'initial';
    let retries = 0;
    let repairs = 0;
    let outputTokens = limits.maxOutputTokens;

    for (;;) {
      const remainingMs = deadline - now().getTime();
      if (remainingMs < MIN_ATTEMPT_MS) return stop('transient', 'timeout');
      // Each attempt is checked as it will go out: a repair adds turns and
      // prompt mode writes the schema into the prompt.
      const outgoing = promptForMode({ ...prompt, turns }, call.mode);
      const inputTokens = estimateTokens(outgoing);
      if (inputTokens > limits.maxInputTokens) return stop('budget_exhausted', 'per_call_input');

      const { pending, attemptStarted, blocked } = reserveAttempt(request, call,
        { purpose, inputTokens, maxOutputTokens: outputTokens, remainingMs });
      if (blocked) return stop('budget_exhausted', blocked);

      let result;
      const attemptSignal = timeoutSignal(remainingMs);
      try {
        result = await adapter.call({ connection: target, secret, request, mode: call.mode, signal: attemptSignal,
          prompt: outgoing, maxOutputTokens: outputTokens, fetchImpl });
      } catch (error) {
        ledger.settleUnknown(pending, { durationMs: now().getTime() - attemptStarted.getTime(), failureReason: 'attempt_error' });
        throw error;
      }
      const verdict = !result.ok ? { failure: result.failure }
        : result.payload !== undefined ? contract.validatePayload(result.payload) : contract.validateReply(result.reply);
      const attempt = {
        ...pending, actualModel: result.actualModel, durationMs: now().getTime() - attemptStarted.getTime(),
        outcome: verdict.ok ? 'succeeded' : verdict.issues ? 'invalid_output' : 'failed',
        failureClass: verdict.ok ? null : verdict.failure?.failureClass ?? 'configuration',
        failureReason: verdict.ok ? null : verdict.failure?.reason ?? 'invalid_output',
        usage: result.usage, estimatedCost: estimateCost(result.usage, target.pricing)
      };
      if (verdict.ok && result.actualModel === target.model && adapter.observesLocalBuild?.(target)) {
        attempt.observedTagDigest = await localBuildAfter(adapter, target, attemptSignal, deadline - now().getTime());
      }
      ledger.settle(attempt);
      attempts.push(attempt);

      if (verdict.ok) {
        call.reportedConfidence = result.reportedConfidence ?? null;
        return { envelope: decisionEnvelope(request, verdict.value), modelReceipt: call.receipt('completed') };
      }
      if (verdict.issues) {
        // JSON outside the schema means the endpoint took the schema and ignored
        // it, as some gateways do: later calls get it in the prompt.
        if (verdict.offSchema && call.mode === 'json_schema') promptOnly.add(formatKey);
        if (!adapter.repairable || repairs >= REPAIR_LIMIT) return stop('configuration', 'invalid_output');
        repairs += 1;
        purpose = 'repair';
        turns = repairTurns(turns, result.reply ?? '', verdict.issues, prompt.schema);
        continue;
      }
      const { failure } = verdict;
      if (failure.reason === 'unsupported_response_format' && call.mode === 'json_schema') {
        promptOnly.add(formatKey);
        call.mode = 'prompt';
        purpose = 'format_fallback';
        continue;
      }
      // Stopped at the output limit, mostly by hidden reasoning: once more with
      // the room no limit of the person's forbids.
      if (failure.reason === 'output_token_limit' && outputTokens < limits.outputRoomTokens) {
        outputTokens = limits.outputRoomTokens;
        purpose = 'retry';
        continue;
      }
      const pauseMs = retryPause(failure, retries, deadline);
      if (pauseMs === null) return fail(failure);
      retries += 1;
      purpose = 'retry';
      await wait(pauseMs);
    }
  }

  // How long to wait before retrying a failed attempt, or null when it is
  // not retried: not transient, out of retries, or past the deadline.
  function retryPause(failure, retries, deadline) {
    if (failure.failureClass !== 'transient' || retries >= TRANSIENT_RETRY_LIMIT) return null;
    const pauseMs = failure.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** retries;
    return now().getTime() + pauseMs + MIN_ATTEMPT_MS > deadline ? null : pauseMs;
  }

  // The semantic role's call (rec#88): its texts as vectors, whole or not at
  // all. The same settings, egress, budget, retry and ledger as a decision;
  // no repair, and no fallback, because a session cannot embed. Texts and
  // vectors never reach the ledger or a log.
  async function embedTexts(request) {
    const call = callRecord({ vectors: null, dimensions: null, model: null });
    const { stop, fail } = call;
    const prepared = await prepare(request, call, { approved: {
      supports: adapter => typeof adapter.embed === 'function', egress: egress => egressAllowed(embeddingEgress(request), egress) } });
    if (prepared.stop) return prepared.stop;
    const { adapter, secret } = prepared;
    const { target, roleConfig, attempts, startedAt } = call;
    call.mode = adapter.outputMode;
    const limits = callLimits(roleConfig.budget, request.budget);
    const deadline = startedAt + limits.timeoutMs;
    const inputTokens = estimateTokens(request.texts);
    if (inputTokens > limits.maxInputTokens) return stop('budget_exhausted', 'per_call_input');
    let purpose = 'initial';
    let retries = 0;

    for (;;) {
      const remainingMs = deadline - now().getTime();
      if (remainingMs < MIN_ATTEMPT_MS) return stop('transient', 'timeout');
      const { pending, attemptStarted, blocked } = reserveAttempt(request, call, { purpose, inputTokens, maxOutputTokens: 0, remainingMs });
      if (blocked) return stop('budget_exhausted', blocked);
      let result;
      try {
        result = await adapter.embed({ connection: target, secret, texts: request.texts, signal: timeoutSignal(remainingMs), fetchImpl,
          builtinEmbed });
      } catch (error) {
        ledger.settleUnknown(pending, { durationMs: now().getTime() - attemptStarted.getTime(), failureReason: 'attempt_error' });
        throw error;
      }
      const failure = result.ok ? null : result.failure;
      const attempt = {
        ...pending, actualModel: result.actualModel, durationMs: now().getTime() - attemptStarted.getTime(),
        outcome: failure ? 'failed' : 'succeeded', failureClass: failure?.failureClass ?? null, failureReason: failure?.reason ?? null,
        usage: result.usage, estimatedCost: estimateCost(result.usage, target.pricing)
      };
      ledger.settle(attempt);
      attempts.push(attempt);
      if (!failure) {
        return { vectors: result.vectors, dimensions: result.dimensions, model: result.actualModel ?? target.model,
          modelReceipt: call.receipt('completed') };
      }
      const pauseMs = retryPause(failure, retries, deadline);
      if (pauseMs === null) return fail(failure);
      retries += 1;
      purpose = 'retry';
      await wait(pauseMs);
    }
  }

  // The local build listed after a valid answer (rec#10 D-32): bounded by the
  // attempt's own deadline signal and by the smaller of what is left and
  // LOCAL_BUILD_MAX_MS, skipped when too little is left. It never extends the
  // deadline and never touches the call budget; the answer is already in hand.
  async function localBuildAfter(adapter, target, attemptSignal, remainingMs) {
    if (remainingMs < LOCAL_BUILD_MIN_MS || attemptSignal.aborted) return null;
    return adapter.observeLocalBuild({ connection: target, fetchImpl,
      signal: AbortSignal.any([attemptSignal, timeoutSignal(Math.min(remainingMs, LOCAL_BUILD_MAX_MS))]) });
  }

  async function decide(input) {
    return run(parseDecisionRequest(input));
  }

  // { role: 'semantic', operation: 'knowledge_embedding', requestId, scope,
  // texts } with at most MAX_EMBEDDING_TEXTS texts, answering { vectors,
  // dimensions, model, modelReceipt }; vectors is null unless it completed.
  async function embed(input) {
    return embedTexts(parseEmbeddingRequest(input));
  }

  return {
    decide,
    embed,
    // A user-run check with fixed synthetic text: it carries no project or
    // user content, so any enabled role may run it within its own budget.
    // The semantic role embeds its one short text instead of deciding.
    checkConnection: role => (role === SEMANTIC_ROLE ? embedTexts(embeddingCheckRequest()) : decide(connectionCheckRequest(role))),
    usage(input) {
      const query = parseUsageQuery(input);
      const loaded = readConfig();
      return { range: { from: query.from, to: query.to }, groups: ledger.usage(query),
        budgets: loaded.state === 'ok' ? roleBudgets(loaded.config, query.role) : [], notes: USAGE_NOTES };
    },
    // What Settings shows per role: which backend answers, never a key. The
    // current session answers a role without a model; an invalid file is a
    // repairable error that answers nothing, never the same as no file (C3).
    // connections and revision are what the console edits from; they hold
    // key references (secretRef) only.
    roles() {
      const loaded = readConfig();
      const roles = loaded.state === 'ok' ? loaded.config.roles : {};
      return { state: loaded.state, error: loaded.error ?? null, revision: configRevision(loaded),
        connections: loaded.state === 'ok' ? loaded.config.connections : {}, roles: MODEL_BACKEND_ROLES.map(role => {
        const settings = roles[role];
        if (loaded.state === 'invalid') return { role, state: 'invalid_config', answeredBy: null };
        if (!settings) return { role, state: 'not_configured', answeredBy: 'current_session' };
        const connection = loaded.config.connections[settings.connection];
        return { role, state: settings.enabled ? 'enabled' : 'disabled', answeredBy: settings.enabled ? 'model_api' : 'current_session',
          connection: { id: settings.connection, protocol: connection.protocol, endpointHost: new URL(connection.endpoint).host,
            model: connection.model, secretRef: connection.secretRef, pricing: connection.pricing ? 'configured' : 'unknown',
            identity: connectionIdentity(settings.connection, connection) },
          allowedOperations: settings.allowedOperations, budget: settings.budget, fallbackToSession: settings.fallbackToSession,
          egress: settings.egress };
      }) };
    },
    // A role's Settings entry while it may send this operation to its model,
    // else null. A role reading it before a call reads it again on every call.
    operationSettings(role, operation) {
      const settings = this.roles().roles.find(entry => entry.role === role);
      return settings?.state === 'enabled' && settings.allowedOperations.includes(operation) ? settings : null;
    },
    // Whether the whole request would still be allowed out now, for a role
    // that rechecks before it shows a late answer. A role that is gone,
    // disabled or no longer allowed the operation allows nothing.
    allowsEgress(request) {
      const settings = this.operationSettings(request.role, request.operation);
      return Boolean(settings) && sendsAllowed(settings, request);
    },
    // Whether the role's own model, as configured now, would stop this request
    // at egress before any attempt (prepare's egress_not_approved). A role
    // without a model for the operation refuses nothing here: its work goes
    // to the current session.
    refusesEgress(request) {
      const settings = this.operationSettings(request.role, request.operation);
      return Boolean(settings) && !sendsAllowed(settings, request);
    },
    // What Settings shows of the local build behind a role's latest answer
    // on its configured endpoint and model (rec#10 D-32). An observation of
    // the local catalog, never proof of what served the answer; it reaches no
    // receipt, review record or gate. Only a connection on the read path
    // (openai_chat on loopback HTTP /v1) applies. connectionId and
    // connection: the role's configured connection, or null.
    // Whether a role's configured model answers (rec#92): ok, failing or
    // unknown (never called yet), and what that is about (rec#122). A failure
    // of the role's own latest call that is not about connectivity is the
    // role's (scope 'role'); no other role's answer clears it. Otherwise the
    // latest attempt on the whole connection configuration, by any role,
    // that says whether it answers (scope 'connection'): a newer answer
    // supersedes an older network failure, and a newer network failure
    // reaches every role on it. An answer that would not validate still came
    // from a working model, so only a failed call counts as failing.
    health(role, connectionId, connection) {
      if (!connection) return null;
      const identity = connectionHealthIdentity(connectionId, connection);
      const own = ledger.lastAttempt({ healthIdentity: identity, role });
      if (own?.outcome === 'failed' && !CONNECTIVITY_REASONS.includes(own.failureReason)) return failingHealth(own, 'role');
      const shared = ledger.lastAttempt({ healthIdentity: identity, connectivityReasons: CONNECTIVITY_REASONS });
      if (!shared) return { status: 'unknown', at: null, reason: null, scope: null };
      return shared.outcome === 'failed' ? failingHealth(shared, 'connection')
        : { status: 'ok', at: shared.at, reason: null, scope: 'connection' };
    },
    localBuild(role, connectionId, connection) {
      const none = status => ({ status, digest: null, completedAt: null });
      if (!connection || !MODEL_ADAPTERS[connection.protocol].observesLocalBuild?.(connection)) return none('not_applicable');
      const last = ledger.lastServed({ role, connectionId, protocol: connection.protocol, endpoint: connection.endpoint,
        requestedModel: connection.model });
      if (!last) return none('no_record');
      return { status: last.observedTagDigest ? 'observed' : 'not_observed', digest: last.observedTagDigest,
        completedAt: last.completedAt };
    },
    // A current-session answer to a work package is an attempt too, kept on
    // its own channel. Its usage is what the session reported, else unknown.
    recordSessionAttempt({ request, attemptId, attemptNumber, startedAt, durationMs, outcome, usage = null }) {
      return ledger.record({ requestId: request.requestId, attemptId, attemptNumber, purpose: attemptNumber > 1 ? 'repair' : 'initial',
        channel: 'session', role: request.role, operation: request.operation, personalSpaceId: request.scope.personalSpaceId,
        personalProjectId: request.scope.personalProjectId, connectionId: null, protocol: null, endpointHost: null,
        requestedModel: null, actualModel: null, outputMode: null, startedAt, durationMs, outcome,
        failureClass: outcome === 'succeeded' ? null : 'configuration', failureReason: outcome === 'succeeded' ? null : 'invalid_output',
        usage: reportedUsage({ ...usage, definition: usage ? 'session_reported' : null }),
        budgetCeilingTokens: 0, estimatedCost: null, costCurrency: null });
    },
    close() {
      ledger.close();
    }
  };

  function roleBudgets(config, onlyRole) {
    return Object.entries(config.roles).filter(([role, settings]) => settings.budget && (!onlyRole || role === onlyRole))
      .map(([role, { budget, connection }]) => {
        const pricing = config.connections[connection].pricing;
        const window = ledger.window({ role, since: windowStart(budget, now()) });
        return { role, windowHours: budget.windowHours, maxTokens: budget.maxTokensPerWindow,
          usedTokens: window.reportedTokens, reservedTokens: window.reservedTokens, maxCost: budget.maxCostPerWindow,
          estimatedCost: pricing ? roundCost(window.estimatedCost) : null, cost: pricing ? 'estimate' : 'unknown' };
      });
  }
}

function failingHealth(attempt, scope) {
  return { status: 'failing', at: attempt.at, reason: attempt.failureReason ?? attempt.failureClass ?? null, scope };
}

// A model on this computer sends nothing out; any other needs the request approved.
function sendsAllowed(settings, request) {
  return MODEL_ADAPTERS[settings.connection.protocol].local === true
    || egressAllowed(request.texts ? embeddingEgress(request) : request, settings.egress);
}

function receiptUsage(attempts) {
  if (!attempts.length) return null;
  const sum = field => attempts.some(attempt => attempt.usage[field] !== null)
    ? attempts.reduce((total, attempt) => total + (attempt.usage[field] ?? 0), 0) : null;
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    unknownAttempts: attempts.filter(attempt => attempt.usage.totalTokens === null).length };
}
