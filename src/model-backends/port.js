import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { MODEL_ADAPTERS } from './adapters/registry.js';
import { budgetBlock, callLimits, ceilingCost, estimateCost, estimateTokens, roundCost, windowStart } from './budget.js';
import { MODEL_BACKEND_ROLES, configRevision, connectionIdentity } from './config.js';
import { decisionContract, decisionEnvelope } from './decision-contract.js';
import { egressAllowed } from './egress.js';
import { FAILURE_STATUS, isFallbackEligible, modelFailure } from './failures.js';
import { decisionPrompt, promptForMode, repairTurns } from './prompt.js';
import { CONNECTION_CHECK, connectionCheckRequest, parseDecisionRequest, parseUsageQuery } from './request.js';
import { reportedUsage } from './usage.js';

// The shared model port of the four built-in Agents (rec#8, D-04). It owns
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
  + 'Costs are estimates from configured unit prices only; without prices the cost is unknown.';

export function createModelBackendPort({ readConfig, secrets, ledger, fetchImpl = globalThis.fetch, wait = delay, now = () => new Date() }) {
  // Endpoints that rejected json_schema output, for this process.
  const promptOnly = new Set();

  async function run(request) {
    const startedAt = now().getTime();
    const attempts = [];
    let target = null;
    let roleConfig = null;
    let mode = null;
    let reportedConfidence = null;

    const receipt = (status, { reason = null, failure = null } = {}) => {
      const fallbackEligible = failure ? isFallbackEligible(failure, roleConfig) : false;
      return {
        backend: 'model_api', status, reason: failure?.reason ?? reason, failureClass: failure?.failureClass ?? null,
        fallbackEligible, fallbackReason: fallbackEligible ? failure.reason : null,
        connection: target?.id ?? null, protocol: target?.protocol ?? null, requestedModel: target?.model ?? null,
        // Which configured connection was asked (config.js connectionIdentity); a role's trust gate compares it.
        connectionIdentity: target ? connectionIdentity(target.id, target) : null,
        actualModel: attempts.findLast(attempt => attempt.actualModel)?.actualModel ?? null,
        outputMode: attempts.length ? mode : null, attempts: attempts.length, usage: receiptUsage(attempts),
        reportedConfidence, durationMs: now().getTime() - startedAt
      };
    };
    const notConfigured = reason => ({ envelope: null, modelReceipt: receipt('not_configured', { reason }) });
    const fail = failure => ({ envelope: null, modelReceipt: receipt(FAILURE_STATUS[failure.failureClass], { failure }) });
    const stop = (failureClass, reason) => fail(modelFailure(failureClass, reason));

    const loaded = readConfig();
    if (loaded.state === 'absent') return notConfigured('no_config');
    if (loaded.state === 'invalid') return stop('configuration', 'invalid_config');
    roleConfig = loaded.config.roles[request.role] ?? null;
    if (!roleConfig) return notConfigured('role_not_configured');
    if (!roleConfig.enabled) return notConfigured('role_disabled');
    if (request.operation !== CONNECTION_CHECK && !roleConfig.allowedOperations.includes(request.operation)) {
      return notConfigured('operation_not_allowed');
    }
    target = { id: roleConfig.connection, ...loaded.config.connections[roleConfig.connection] };
    const adapter = MODEL_ADAPTERS[target.protocol];
    if (!adapter.supports(request)) return stop('configuration', 'unsupported_output');
    if (!egressAllowed(request, roleConfig.egress)) return stop('refusal', 'egress_not_approved');

    let secret = null;
    if (target.secretRef) {
      try {
        secret = await secrets.read(target.secretRef);
      } catch (error) {
        return stop('configuration', error?.code === 'secret_store_insecure' ? 'secret_store_insecure' : 'secret_unreadable');
      }
      if (!secret) return stop('configuration', 'missing_key');
    }

    const contract = decisionContract(request);
    const prompt = decisionPrompt(request, contract.providerSchema);
    const limits = callLimits(roleConfig.budget, request.budget);
    const deadline = startedAt + limits.timeoutMs;
    const formatKey = `${target.protocol} ${target.endpoint} ${target.model}`;
    mode = adapter.outputMode === 'json_schema' && promptOnly.has(formatKey) ? 'prompt' : adapter.outputMode;
    let turns = prompt.turns;
    let purpose = 'initial';
    let retries = 0;
    let repairs = 0;

    for (;;) {
      const remainingMs = deadline - now().getTime();
      if (remainingMs < MIN_ATTEMPT_MS) return stop('transient', 'timeout');
      // Each attempt is checked as it will go out: a repair adds turns and
      // prompt mode writes the schema into the prompt.
      const outgoing = promptForMode({ ...prompt, turns }, mode);
      const inputTokens = estimateTokens(outgoing);
      if (inputTokens > limits.maxInputTokens) return stop('budget_exhausted', 'per_call_input');

      const attemptStarted = now();
      const pending = {
        requestId: request.requestId, attemptId: randomUUID(), attemptNumber: attempts.length + 1, purpose, channel: 'model_api',
        role: request.role, operation: request.operation, personalSpaceId: request.scope.personalSpaceId,
        personalProjectId: request.scope.personalProjectId, connectionId: target.id, protocol: target.protocol,
        endpointHost: new URL(target.endpoint).host, endpoint: target.endpoint, requestedModel: target.model, outputMode: mode,
        startedAt: attemptStarted.toISOString(), budgetCeilingTokens: inputTokens + limits.maxOutputTokens,
        costCurrency: target.pricing?.currency ?? null
      };
      const blocked = ledger.reserve({ attempt: pending, ceilingCost: ceilingCost(target.pricing, inputTokens, limits.maxOutputTokens),
        expiresAt: new Date(attemptStarted.getTime() + remainingMs + RESERVATION_GRACE_MS).toISOString(),
        since: windowStart(roleConfig.budget, attemptStarted), now: attemptStarted.toISOString(),
        check: window => budgetBlock({ budget: roleConfig.budget, pricing: target.pricing, window,
          estimatedInputTokens: inputTokens, maxOutputTokens: limits.maxOutputTokens }) });
      if (blocked) return stop('budget_exhausted', blocked);

      let result;
      const attemptSignal = AbortSignal.timeout(remainingMs);
      try {
        result = await adapter.call({ connection: target, secret, request, mode, signal: attemptSignal,
          prompt: outgoing, maxOutputTokens: limits.maxOutputTokens, fetchImpl });
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
        reportedConfidence = result.reportedConfidence ?? null;
        return { envelope: decisionEnvelope(request, verdict.value), modelReceipt: receipt('completed') };
      }
      if (verdict.issues) {
        if (!adapter.repairable || repairs >= REPAIR_LIMIT) return stop('configuration', 'invalid_output');
        repairs += 1;
        purpose = 'repair';
        turns = repairTurns(turns, result.reply ?? '', verdict.issues);
        continue;
      }
      const { failure } = verdict;
      if (failure.reason === 'unsupported_response_format' && mode === 'json_schema') {
        promptOnly.add(formatKey);
        mode = 'prompt';
        purpose = 'format_fallback';
        continue;
      }
      if (failure.failureClass !== 'transient' || retries >= TRANSIENT_RETRY_LIMIT) return fail(failure);
      const pauseMs = failure.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** retries;
      if (now().getTime() + pauseMs + MIN_ATTEMPT_MS > deadline) return fail(failure);
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
      signal: AbortSignal.any([attemptSignal, AbortSignal.timeout(Math.min(remainingMs, LOCAL_BUILD_MAX_MS))]) });
  }

  async function decide(input) {
    return run(parseDecisionRequest(input));
  }

  return {
    decide,
    // A user-run check with fixed synthetic text: it carries no project or
    // user content, so any enabled role may run it within its own budget.
    checkConnection: role => decide(connectionCheckRequest(role)),
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
      return Boolean(settings) && egressAllowed(request, settings.egress);
    },
    // What Settings shows of the local build behind a role's latest answer
    // on its configured endpoint and model (rec#10 D-32). An observation of
    // the local catalog, never proof of what served the answer; it reaches no
    // receipt, review record or gate. Only a connection on the read path
    // (openai_chat on loopback HTTP /v1) applies. connectionId and
    // connection: the role's configured connection, or null.
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

function receiptUsage(attempts) {
  if (!attempts.length) return null;
  const sum = field => attempts.some(attempt => attempt.usage[field] !== null)
    ? attempts.reduce((total, attempt) => total + (attempt.usage[field] ?? 0), 0) : null;
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    unknownAttempts: attempts.filter(attempt => attempt.usage.totalTokens === null).length };
}
