// The tokens a woken client reported for its run, as that client counts
// them: inputParts are disjoint counts that add up to the whole input. A part
// that is missing or not a whole count makes that side unknown (null); FULI
// never fills one in. Null when the client reported neither side.
export function reportedWakeUsage({ inputParts, output }) {
  const counts = inputParts.map(tokenCount);
  const usage = { inputTokens: counts.includes(null) ? null : counts.reduce((sum, count) => sum + count, 0),
    outputTokens: tokenCount(output) };
  return usage.inputTokens === null && usage.outputTokens === null ? null : usage;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
