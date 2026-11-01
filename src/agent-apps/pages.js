import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';

import { createRunGate } from './run-gate.js';

// A page app's files for the console's app frame (#346 0.23 Apps): the
// active version's runtime.webRoot, and only while the run gate accepts that
// version, checked on every file as it is for every start. A page has no
// process, so this gate is the whole of what keeps an unconfirmed page from
// opening. Nothing outside webRoot is served: a path leaving it, through
// `..` or a link on disk, is not found. The HTTP side
// (src/http/agent-app-page-router.js) adds the sandbox that keeps the page
// away from the console's origin.
export function createAppPages(context) {
  const { store } = context;
  const { runGate } = createRunGate(context);

  // path: the request path below /app-pages/<appId>/, already decoded; empty or
  // ending in / names that folder's index.html.
  function pageFile({ appId, path }) {
    const app = store.app(appId);
    if (!app) return notFound();
    const gate = runGate({ appId });
    if (gate.status !== 'ready') return gate;
    const webRoot = store.version(appId, app.activeVersion).manifest.runtime.webRoot;
    if (!webRoot) return { status: 'not_page', message: 'This app has no page; it runs as a service or a tool only.' };
    const root = realpathSync(join(context.packageOf(appId, app.activeVersion), webRoot));
    const requested = resolve(root, path === '' || path.endsWith('/') ? `${path}index.html` : path);
    if (!inside(root, requested) || !existsSync(requested)) return notFound();
    const filePath = realpathSync(requested);
    return inside(root, filePath) && statSync(filePath).isFile() ? { status: 'ready', filePath } : notFound();
  }

  return { pageFile };
}

const notFound = () => ({ status: 'not_found', message: 'No such page file.' });

function inside(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
