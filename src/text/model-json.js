// A model's JSON answer, tolerating one surrounding Markdown code fence.
// Throws SyntaxError when the remaining text is not JSON.
export function parseModelJson(body) {
  const trimmed = body.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}
