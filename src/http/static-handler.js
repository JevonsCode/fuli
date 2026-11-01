import { existsSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const WEB_ROOT = join(PROJECT_ROOT, 'dist', 'web');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

export function serveStatic(pathname, response) {
  if (pathname === '/favicon.ico') {
    // web/public/favicon.ico, generated from brand/ by scripts/build-brand-assets.js.
    const filePath = join(WEB_ROOT, 'favicon.ico');
    if (!existsSync(filePath)) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, {
      'cache-control': 'public, max-age=86400',
      'content-type': 'image/x-icon'
    });
    response.end(readFileSync(filePath));
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const requestedFile = normalize(join(WEB_ROOT, relativePath));
  const pathFromRoot = relative(WEB_ROOT, requestedFile);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Not found');
    return;
  }

  const filePath = existsSync(requestedFile)
    ? requestedFile
    : shouldServeApplication(pathname)
      ? join(WEB_ROOT, 'index.html')
      : null;
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    ...(extname(filePath) === '.html' ? { 'cache-control': 'no-cache' } : {})
  });
  response.end(readFileSync(filePath));
}

function shouldServeApplication(pathname) {
  // Agent identities (for example employee.jefa) are route parameters, not assets.
  const agentProfile = /^\/agents\/[^/]+\/[^/]+\/?$/.test(pathname);
  return !pathname.startsWith('/api/') && (agentProfile || extname(pathname) === '');
}
