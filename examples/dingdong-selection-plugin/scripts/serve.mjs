import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requestedPort = Number.parseInt(process.env.PORT ?? '4178', 10);
const port = Number.isSafeInteger(requestedPort) && requestedPort > 0 ? requestedPort : 4178;
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8']
]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const candidate = normalize(join(root, relative));
    if (!candidate.startsWith(`${root}/`)) {
      respond(response, 403, 'Forbidden');
      return;
    }
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(candidate);
    response.writeHead(200, {
      'content-type': types.get(extname(candidate)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; connect-src https: http://127.0.0.1:* http://localhost:*; style-src 'self'; script-src 'self'"
    });
    response.end(body);
  } catch {
    respond(response, 404, 'Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Selection plugin: http://127.0.0.1:${port}\n`);
});

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}
