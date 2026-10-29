// A rough model-token count for a text an Agent may choose to read: about four
// ASCII characters per token, one token per other code point (CJK, emoji).
// Only a reading-cost hint; never a budget that decides what is delivered.
export function approxTokens(text) {
  let ascii = 0, other = 0;
  for (const point of text) {
    if (point.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}
