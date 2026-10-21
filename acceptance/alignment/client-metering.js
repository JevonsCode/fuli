import { reportedUsage, tokenCount } from '../../src/model-backends/usage.js';

// What one client process reported about its own consumption, read only from
// the frozen client contract below (also in
// acceptance/p0-acceptance-and-cost-baseline.md §2.2). A field the client did
// not report stays null (unknown) and an explicit 0 stays 0. Token counts come
// from the client's token fields only, never from characters or bytes of its
// output. A cost carries the label of its source; costs from different sources
// are never added together.
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
const PARTIAL_BUDGET_STOP = 'budget_stop';
const CODEX_SOURCE_COMMIT = '067249a28329feec4a097f55413894acb4a6378a';

// The versions whose output this parser follows. Fields outside these
// contracts are not read, and there are no aliases: a field another version
// names differently reads as unknown. The run records the local client
// versions next to this contract; they are not verified against it.
export const CLIENT_METERING_CONTRACT = Object.freeze({
  codex: Object.freeze({
    source: `openai/codex@${CODEX_SOURCE_COMMIT} codex-rs/exec/src/exec_events.rs L61-72 (Usage)`,
    event: 'turn.completed.usage',
    fields: Object.freeze([
      'input_tokens',
      'cached_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'reasoning_output_tokens'
    ]),
    cost: 'not reported'
  }),
  claudeCode: Object.freeze({
    source: 'Claude Code `claude -p --output-format stream-json` result message, per ' +
      'https://code.claude.com/docs/en/agent-sdk/cost-tracking (read 2026-10-22)',
    event: 'result.usage, result.total_cost_usd',
    fields: Object.freeze([
      'input_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'output_tokens'
    ]),
    cost: 'total_cost_usd, a client-side estimate, not a bill',
    scope: 'usage counts the top-level loop only, not subagents; the runner restricts tools accordingly'
  })
});

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
// event carries the call's totals: assistant messages repeat per-request usage
// with a placeholder output count, so adding them would count tokens twice.
export function claudeMetering(events) {
  const result = events.findLast((event) => event?.type === 'result');
  const usage = result?.usage ?? {};
  let reported = Object.fromEntries(CLIENT_METERING_CONTRACT.claudeCode.fields
    .map((field) => [field, tokenCount(usage[field])]));
  let costUsd = usd(result?.total_cost_usd);
  const flags = [];
  // A crash's final error_during_execution result may carry every cost field
  // zeroed; zeros there are not a measurement.
  if (result?.subtype === 'error_during_execution'
    && [...Object.values(reported), costUsd].every((value) => value === 0 || value === null)) {
    reported = Object.fromEntries(Object.keys(reported).map((field) => [field, null]));
    costUsd = null;
    flags.push('zeroed_crash_result');
  }
  // A budget stop's usage leaves out the response that crossed the budget
  // while its total_cost_usd includes it: the cost stands, the tokens are a
  // known subtotal only.
  const partialTokens = result?.subtype === 'error_max_budget_usd' ? PARTIAL_BUDGET_STOP : null;
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
    costUsd,
    costSource: CLIENT_REPORTED,
    partialTokens,
    flags
  });
}

// Codex `turn.completed.usage`. At the contract commit, turn.completed carries
// the thread's running total (event_processor_with_jsonl_output.rs L509-535
// keeps the last ThreadTokenUsageUpdated total and emits it), so a later
// snapshot replaces an earlier one instead of adding to it. cached_input_tokens
// and cache_write_input_tokens are parts of input_tokens (both come from the
// Responses API's input_tokens_details), reasoning_output_tokens part of
// output_tokens. Codex reports no cost.
export function codexMetering(events) {
  const turn = events.findLast((event) => event?.type === 'turn.completed');
  const usage = turn?.usage ?? {};
  const reported = Object.fromEntries(CLIENT_METERING_CONTRACT.codex.fields
    .map((field) => [field, tokenCount(usage[field])]));
  return attemptMetering({
    client: 'codex',
    reported,
    usage: reportedUsage({
      inputTokens: reported.input_tokens,
      outputTokens: reported.output_tokens,
      cachedInputTokens: reported.cached_input_tokens,
      cacheWriteInputTokens: reported.cache_write_input_tokens,
      reasoningTokens: reported.reasoning_output_tokens,
      definition: 'codex_exec_turn_usage'
    }),
    costUsd: null,
    costSource: null,
    partialTokens: null,
    flags: []
  });
}

// Runs a client up to maxAttempts times and keeps every attempt's outcome,
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
    attemptOutcomes: attempts.map(attemptOutcome)
  };
}

export function attemptOutcome({ error, metering }) {
  return { failed: Boolean(error), metering };
}

// The persisted metering of one client in a run: one redacted record per
// attempt (no stdout, answers or error text) and the totals over them.
export function meteringLedger() {
  return { attempts: [], totals: meteringTotals([]) };
}

export function recordAttempts(ledger, callId, outcomes) {
  outcomes.forEach(({ failed, metering }, index) => {
    ledger.attempts.push({
      callId,
      attempt: index + 1,
      status: failed ? 'failed' : 'completed',
      ...metering
    });
  });
  ledger.totals = meteringTotals(ledger.attempts);
}

// The known subtotal of each field, how many attempts did not report it or
// reported only part of it, and whether the subtotal is complete. A field no
// attempt reported has no subtotal (null), never 0.
function meteringTotals(attempts) {
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [
    field,
    knownSubtotal(attempts.map(({ usage, partialTokens }) => ({ value: usage[field], partialTokens })))
  ]));
  const partialTokenAttempts = {};
  for (const { partialTokens } of attempts) {
    if (partialTokens) partialTokenAttempts[partialTokens] = (partialTokenAttempts[partialTokens] ?? 0) + 1;
  }
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
    partialTokenAttempts,
    cost,
    complete: tokens.inputTokens.complete && tokens.outputTokens.complete && cost.complete
  };
}

export function roundMoney(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * MONEY_SCALE) / MONEY_SCALE
    : null;
}

function attemptMetering({ client, reported, usage, costUsd, costSource, partialTokens, flags }) {
  return {
    client,
    reported,
    usage,
    // A reason code when the reported tokens are known to be only part of the
    // attempt's consumption.
    partialTokens,
    cost: { usd: costUsd, source: costUsd === null ? null : costSource },
    notReported: [
      ...Object.keys(reported).filter((field) => reported[field] === null),
      ...(costUsd === null ? ['cost'] : [])
    ],
    flags
  };
}

function knownSubtotal(entries) {
  const known = entries.filter(({ value }) => value !== null);
  const partialAttempts = known.filter(({ partialTokens }) => partialTokens).length;
  return {
    knownSubtotal: known.length || !entries.length
      ? known.reduce((sum, { value }) => sum + value, 0)
      : null,
    unknownAttempts: entries.length - known.length,
    partialAttempts,
    complete: known.length === entries.length && !partialAttempts
  };
}

function usd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
