// A model's JSON answer, tolerating one surrounding Markdown code fence and
// words before or after the one object it holds ("Here is the JSON: {...}").
// Throws SyntaxError when no JSON object can be read.
export function parseModelJson(body) {
  const trimmed = body.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start || (start === 0 && end === trimmed.length - 1)) throw error;
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
