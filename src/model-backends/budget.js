// Per-call and per-window limits of one role. Every role has its own pool,
// even when roles share a connection, and nothing switches to another pool.
// An attempt whose usage is unknown counts at the ceiling it was allowed.

// Conservative estimate: overcounts English text and gives about one token
// per CJK character (three UTF-8 bytes), before any provider tokenizer runs.
const ESTIMATED_BYTES_PER_TOKEN = 2.5;
const PER_MILLION = 1_000_000;
const COST_PRECISION = 1e10;

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value)) / ESTIMATED_BYTES_PER_TOKEN);
}

// A request may tighten the role's per-call limits, never widen them.
export function callLimits(budget, requested = {}) {
  return {
    maxInputTokens: budget.maxInputTokens,
    maxOutputTokens: Math.min(budget.maxOutputTokens, requested.maxOutputTokens ?? Infinity),
    timeoutMs: Math.min(budget.timeoutMs, requested.timeoutMs ?? Infinity)
  };
}

export function windowStart(budget, now) {
  return new Date(now.getTime() - budget.windowHours * 3_600_000).toISOString();
}

// The reason the next attempt may not start, or null.
export function budgetBlock({ budget, pricing, window, estimatedInputTokens, maxOutputTokens }) {
  const ceiling = estimatedInputTokens + maxOutputTokens;
  if (window.reportedTokens + window.reservedTokens + ceiling > budget.maxTokensPerWindow) return 'window_tokens';
  if (budget.maxCostPerWindow === null) return null;
  const highestPrice = Math.max(pricing.inputPerMillionTokens, pricing.outputPerMillionTokens) / PER_MILLION;
  const spent = window.estimatedCost + window.unpricedTokens * highestPrice;
  const next = (estimatedInputTokens * pricing.inputPerMillionTokens + maxOutputTokens * pricing.outputPerMillionTokens) / PER_MILLION;
  return spent + next > budget.maxCostPerWindow ? 'window_cost' : null;
}

// A labelled estimate from configured unit prices; null when prices or the
// reported input and output are missing.
export function estimateCost(usage, pricing) {
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null) return null;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cost = ((usage.inputTokens - cached) * pricing.inputPerMillionTokens
    + cached * (pricing.cachedInputPerMillionTokens ?? pricing.inputPerMillionTokens)
    + usage.outputTokens * pricing.outputPerMillionTokens) / PER_MILLION;
  return roundCost(cost);
}

export function roundCost(value) {
  return Math.round(value * COST_PRECISION) / COST_PRECISION;
}
