// One model exchange of the Tonborg review evaluation, kept exactly as sent
// and received for the raw per-case record (rec#26). The body is read once to
// record it, so the caller gets a fresh Response carrying the same text.

// A re-wrapped body is already decoded and its length is the text's own.
const STALE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

export async function recordedExchange({ target, method, body, response, onExchange }) {
  const responseText = await response.text();
  onExchange({ url: target.href, method: method.toUpperCase(), requestBody: body ?? null,
    status: response.status, contentType: response.headers.get('content-type'), responseText });
  const headers = new Headers(response.headers);
  for (const name of STALE_HEADERS) headers.delete(name);
  return new Response(responseText, { status: response.status, statusText: response.statusText, headers });
}
