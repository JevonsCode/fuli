import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

// fetch refuses the ports browsers block, such as 6665 to 6669, with "bad port".
// That rule protects web pages from other protocols; a model server the person
// set up on one of those ports is simply where their model lives. Such a call
// goes through node:http instead, unchanged: it follows no redirect, so the
// refusal in no-redirect-fetch.js still applies.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export async function modelFetch(url, init = {}) {
  try {
    return await globalThis.fetch(url, init);
  } catch (error) {
    if (error?.cause?.message !== 'bad port') throw error;
    return sendOverNodeHttp(url, init);
  }
}

function sendOverNodeHttp(url, { method = 'GET', headers = {}, body, signal }) {
  const send = new URL(url).protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    // No pooled socket: a server that closed one between calls would read as a network fault.
    const outgoing = send(url, { method, headers, signal, agent: false }, (incoming) => {
      const received = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        for (const item of [value].flat()) received.append(name, item);
      }
      resolve(new Response(NULL_BODY_STATUSES.has(incoming.statusCode) ? null : Readable.toWeb(incoming),
        { status: incoming.statusCode, headers: received }));
    });
    // As fetch does: a cut request fails with why it was cut, which tells a timeout from a network fault.
    outgoing.on('error', error => reject(signal?.aborted ? signal.reason : error));
    outgoing.end(body);
  });
}
