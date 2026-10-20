import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { MODEL_ADAPTERS } from './adapters/registry.js';
import { budgetBlock, callLimits, estimateCost, estimateTokens, roundCost, windowStart } from './budget.js';
import { decisionContract } from './decision-contract.js';
import { egressAllowed } from './egress.js';
import { FAILURE_STATUS, isFallbackEligible, modelFailure } from './failures.js';
import { decisionPrompt, promptForMode, repairTurns } from './prompt.js';
import { CONNECTION_CHECK, connectionCheckRequest, parseDecisionRequest, parseUsageQuery } from './request.js';

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
    const estimatedInputTokens = estimateTokens(prompt);
    if (estimatedInputTokens > limits.maxInputTokens) return stop('budget_exhausted', 'per_call_input');
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
      const blocked = budgetBlock({ budget: roleConfig.budget, pricing: target.pricing, estimatedInputTokens,
        maxOutputTokens: limits.maxOutputTokens,
        window: ledger.window({ role: request.role, since: windowStart(roleConfig.budget, now()) }) });
      if (blocked) return stop('budget_exhausted', blocked);

      const attemptStarted = now();
      const result = await adapter.call({ connection: target, secret, request, mode, signal: AbortSignal.timeout(remainingMs),
        prompt: promptForMode({ ...prompt, turns }, mode), maxOutputTokens: limits.maxOutputTokens, fetchImpl });
      const verdict = !result.ok ? { failure: result.failure }
        : result.payload !== undefined ? contract.validatePayload(result.payload) : contract.validateReply(result.reply);
      const attempt = {
        requestId: request.requestId, attemptId: randomUUID(), attemptNumber: attempts.length + 1, purpose, channel: 'model_api',
        role: request.role, operation: request.operation, personalSpaceId: request.scope.personalSpaceId,
        personalProjectId: request.scope.personalProjectId, connectionId: target.id, protocol: target.protocol,
        endpointHost: new URL(target.endpoint).host, requestedModel: target.model, actualModel: result.actualModel,
        outputMode: mode, startedAt: attemptStarted.toISOString(), durationMs: now().getTime() - attemptStarted.getTime(),
        outcome: verdict.ok ? 'succeeded' : verdict.issues ? 'invalid_output' : 'failed',
        failureClass: verdict.ok ? null : verdict.failure?.failureClass ?? 'configuration',
        failureReason: verdict.ok ? null : verdict.failure?.reason ?? 'invalid_output',
        usage: result.usage, budgetCeilingTokens: estimatedInputTokens + limits.maxOutputTokens,
        estimatedCost: estimateCost(result.usage, target.pricing), costCurrency: target.pricing?.currency ?? null
      };
      ledger.record(attempt);
      attempts.push(attempt);

      if (verdict.ok) {
        reportedConfidence = result.reportedConfidence ?? null;
        return { envelope: envelope(request, verdict.value), modelReceipt: receipt('completed') };
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

function envelope(request, value) {
  return {
    role: request.role, operation: request.operation, requestId: request.requestId, sourceEventId: request.sourceEventId,
    scope: request.scope,
    evidence: { refs: value.evidenceIds, evidenceVersion: request.versions.evidence, policyVersion: request.versions.policy },
    decision: value.decision, payload: value.payload, reason: value.reason, uncertainty: value.uncertainty,
    execution: { status: 'pending' }
  };
}

function receiptUsage(attempts) {
  if (!attempts.length) return null;
  const sum = field => attempts.some(attempt => attempt.usage[field] !== null)
    ? attempts.reduce((total, attempt) => total + (attempt.usage[field] ?? 0), 0) : null;
  return { inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens'),
    unknownAttempts: attempts.filter(attempt => attempt.usage.totalTokens === null).length };
}
