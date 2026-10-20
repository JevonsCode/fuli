// Reported model usage for one attempt. A value the provider did not report
// stays null (unknown), never 0. cachedInput and cacheWriteInput are subsets
// of input, reasoning a subset of output, each as its provider defines them;
// total is input + output and never adds a subset again.

export function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function reportedUsage({
  inputTokens = null, outputTokens = null, cachedInputTokens = null,
  cacheWriteInputTokens = null, reasoningTokens = null, definition
}) {
  const input = tokenCount(inputTokens);
  const output = tokenCount(outputTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input !== null && output !== null ? input + output : null,
    cachedInputTokens: tokenCount(cachedInputTokens),
    cacheWriteInputTokens: tokenCount(cacheWriteInputTokens),
    reasoningTokens: tokenCount(reasoningTokens),
    definition
  };
}
