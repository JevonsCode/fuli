// A model request goes only to the URL that was checked. Native fetch
// follows redirects by default, and a 307 or 308 resends the body, which can
// hold project content, to a host no egress or endpoint check has seen. So
// every model request asks for redirects unfollowed and refuses any redirect
// answer: a 3xx status (Node's fetch returns it as is), an opaque redirect
// (the browser form of the same answer), or a response that reports it was
// redirected anyway (a fetch that ignores `redirect`).

export class RedirectRefusedError extends Error {
  constructor(url) {
    super(`Refusing a redirect from ${url}`);
    this.name = 'RedirectRefusedError';
  }
}

export async function fetchWithoutRedirect(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.redirected) {
    // Releasing the body is cleanup only; its failure never replaces the refusal.
    try {
      await response.body?.cancel();
    } catch {}
    throw new RedirectRefusedError(url);
  }
  return response;
}
