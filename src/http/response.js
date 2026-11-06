// Keep local API request buffering at or below a fixed 64 KiB budget.
const MAX_JSON_BODY_BYTES = 64 * 1024;

export class JsonBodyTooLargeError extends Error {
  constructor() {
    super(`JSON request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    this.name = 'JsonBodyTooLargeError';
  }
}

export async function readJson(request) {
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    receivedBytes += chunk.length;
    if (receivedBytes > MAX_JSON_BODY_BYTES) {
      chunks.length = 0;
      throw new JsonBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

// An uploaded portrait (an Agent's look, the person's 「我」) by its version:
// the URL carries the version, so a changed picture is a new URL and one
// version can be kept by the browser; the type comes from the bytes. missing
// is the 404 body when there is no picture.
export function sendPortrait(response, picture, missing) {
  if (!picture) {
    sendJson(response, 404, missing);
    return;
  }
  response.writeHead(200, { 'content-type': picture.mediaType, 'content-length': picture.bytes.length,
    'cache-control': 'private, max-age=31536000, immutable', etag: `"${picture.version}"`,
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
  response.end(picture.bytes);
}
