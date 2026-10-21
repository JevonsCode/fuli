import { reportedUsage, tokenCount } from '../../src/model-backends/usage.js';

// What one client process reported about its own consumption, read only from
// the frozen client contract in acceptance/p0-acceptance-and-cost-baseline.md
// §2.2. A field the client did not report stays null (unknown) and an explicit
// 0 stays 0. Token counts come from the client's token fields only, never from
// characters or bytes of its output. A cost carries the label of its source;
// costs from different sources are never added together.
//
// This module parses and adds up; it never starts a client.

const CLIENT_REPORTED = 'client_reported';
const MONEY_SCALE = 1_000_000;
const TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens'
]);

export function parseJsonLines(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Raw model output is intentionally discarded; only structured events are retained.
    }
  }
  return events;
}

// Claude Code `result.usage` and `result.total_cost_usd`. Only the final result
// event carries the session's totals: assistant messages repeat per-request
// usage, so adding them as well would count the same tokens twice.
export function claudeMetering(events) {
  const result = events.findLast((event) => event?.type === 'result');
  const usage = result?.usage ?? {};
  const reported = {
    input_tokens: tokenCount(usage.input_tokens),
    cache_creation_input_tokens: tokenCount(usage.cache_creation_input_tokens),
    cache_read_input_tokens: tokenCount(usage.cache_read_input_tokens),
    output_tokens: tokenCount(usage.output_tokens)
  };
  // Claude's input_tokens excludes cache reads and writes; the three are
  // disjoint, so the whole input is their sum and unknown if any part is.
  const inputParts = [
    reported.input_tokens,
    reported.cache_read_input_tokens,
    reported.cache_creation_input_tokens
  ];
  return attemptMetering({
    client: 'claude_code',
    reported,
    usage: reportedUsage({
      inputTokens: inputParts.includes(null)
        ? null
        : inputParts.reduce((sum, value) => sum + value, 0),
      outputTokens: reported.output_tokens,
      cachedInputTokens: reported.cache_read_input_tokens,
      cacheWriteInputTokens: reported.cache_creation_input_tokens,
      definition: 'claude_code_result_usage'
    }),
    costUsd: usd(result?.total_cost_usd),
    costSource: CLIENT_REPORTED
  });
}

// Codex `turn.completed.usage`. Codex reports the thread's running total there,
// so a later snapshot replaces an earlier one instead of adding to it. Its
// cached_input_tokens is part of input_tokens and reasoning_tokens part of
// output_tokens. Codex reports no cost.
export function codexMetering(events) {
  const turn = events.findLast((event) => event?.type === 'turn.completed');
  const usage = turn?.usage ?? {};
  const reported = {
    input_tokens: tokenCount(usage.input_tokens),
    cached_input_tokens: tokenCount(usage.cached_input_tokens),
    output_tokens: tokenCount(usage.output_tokens),
    reasoning_tokens: tokenCount(usage.reasoning_tokens)
  };
  return attemptMetering({
    client: 'codex',
    reported,
    usage: reportedUsage({
      inputTokens: reported.input_tokens,
      outputTokens: reported.output_tokens,
      cachedInputTokens: reported.cached_input_tokens,
      reasoningTokens: reported.reasoning_tokens,
      definition: 'codex_exec_turn_usage'
    }),
    costUsd: null,
    costSource: null
  });
}

// Runs a client up to maxAttempts times and keeps every attempt's metering,
// not only the last result's: a failed or retried attempt still consumed what
// it reported.
export async function runMeteredAttempts({ maxAttempts, runAttempt, shouldRetry }) {
  const attempts = [];
  for (let number = 1; number <= maxAttempts; number += 1) {
    const attempt = await runAttempt(number);
    attempts.push(attempt);
    if (!shouldRetry(attempt)) break;
  }
  return {
    ...attempts.at(-1),
    attempts: attempts.length,
    attemptMetering: attempts.map(({ metering }) => metering)
  };
}

// The known subtotal of each field, how many attempts did not report it, and
// whether the subtotal is complete. A field no attempt reported has no
// subtotal (null), never 0.
export function meteringTotals(attempts) {
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [
    field,
    knownSubtotal(attempts.map(({ usage }) => usage[field]))
  ]));
  const knownCosts = attempts.filter(({ cost }) => cost.usd !== null);
  const knownUsdBySource = {};
  for (const { cost } of knownCosts) {
    knownUsdBySource[cost.source] = (knownUsdBySource[cost.source] ?? 0) + cost.usd;
  }
  const cost = {
    knownUsdBySource: Object.fromEntries(
      Object.entries(knownUsdBySource).map(([source, value]) => [source, roundMoney(value)])
    ),
    unknownAttempts: attempts.length - knownCosts.length,
    complete: knownCosts.length === attempts.length
  };
  return {
    attempts: attempts.length,
    tokens,
    cost,
    complete: tokens.inputTokens.complete && tokens.outputTokens.complete && cost.complete
  };
}

export function roundMoney(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * MONEY_SCALE) / MONEY_SCALE
    : null;
}

function attemptMetering({ client, reported, usage, costUsd, costSource }) {
  return {
    client,
    reported,
    usage,
    cost: { usd: costUsd, source: costUsd === null ? null : costSource },
    notReported: [
      ...Object.keys(reported).filter((field) => reported[field] === null),
      ...(costUsd === null ? ['cost'] : [])
    ]
  };
}

function knownSubtotal(values) {
  const known = values.filter((value) => value !== null);
  return {
    knownSubtotal: known.length || !values.length
      ? known.reduce((sum, value) => sum + value, 0)
      : null,
    unknownAttempts: values.length - known.length,
    complete: known.length === values.length
  };
}

function usd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
