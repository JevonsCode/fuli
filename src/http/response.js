// Keep local API request buffering at or below a fixed 64 KiB budget.
export const MAX_JSON_BODY_BYTES = 64 * 1024;

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
