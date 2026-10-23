// A model request goes only to the URL that was checked. Native fetch
// follows redirects by default, and a 307 or 308 resends the body, which can
// hold project content, to a host no egress or endpoint check has seen. So
// every model request refuses redirects, and a response that still reports
// one (a fetch that ignores `redirect`) is refused too.

export class RedirectRefusedError extends Error {
  constructor(url) {
    super(`Refusing a redirect from ${url}`);
    this.name = 'RedirectRefusedError';
  }
}

export async function fetchWithoutRedirect(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (error) {
    // Node's fetch (undici) rejects a refused redirect as a TypeError whose
    // cause is "unexpected redirect".
    if (error?.cause?.message === 'unexpected redirect') throw new RedirectRefusedError(url);
    throw error;
  }
  if (response.redirected) {
    await response.body?.cancel();
    throw new RedirectRefusedError(url);
  }
  return response;
}
