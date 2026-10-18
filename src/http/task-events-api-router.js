import { PassThrough, Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';

const streams = new WeakMap();

export function closeTaskEventStreams(server) {
  for (const controller of streams.get(server) ?? []) controller.abort();
}

export async function handleTaskEventsRequest({ request, response, url, app }) {
  if (request.method !== 'GET' || url.pathname !== '/api/project-agent-task-events') return false;
  const controller = new AbortController();
  const server = request.socket.server;
  if (!streams.has(server)) streams.set(server, new Set());
  const active = streams.get(server);
  active.add(controller);
  const disconnect = () => controller.abort();
  response.once('close', disconnect);
  let unsubscribe = () => {};
  try {
    const upstream = await app.openProjectAgentTaskEvents({
      personalSpaceId: url.searchParams.get('personalSpaceId')
    }, { signal: controller.signal });
    response.writeHead(200, { 'content-type': 'text/event-stream',
      'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    const output = new PassThrough();
    // Upstream chunks may split an SSE frame or UTF-8 character. Inject chat
    // only between whole frames, never in the middle of a provider data field.
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const frames = new Transform({ transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        this.push(pending.slice(0, end + 2)); pending = pending.slice(end + 2);
      }
      if (Buffer.byteLength(pending) > 256 * 1024) return callback(new Error('Task event frame too large'));
      callback();
    } });
    if (!url.searchParams.get('personalSpaceId') || url.searchParams.get('personalSpaceId') === app.config?.personal?.spaceId) {
      unsubscribe = app.roundtable?.subscribeChatUpdates?.((event, error, phase) => {
        if (output.writableLength > 96 * 1024) return controller.abort();
        if (error || phase === 'ready') {
          output.write(`event: ${error ? 'chat-unavailable' : 'chat-ready'}\ndata: {}\n\n`);
          return;
        }
        output.write(`event: chat\ndata: ${JSON.stringify(event)}\n\n`);
      }) ?? unsubscribe;
    }
    await pipeline(Readable.fromWeb(upstream.body), frames, output, response, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    unsubscribe();
    response.off('close', disconnect);
    controller.abort();
    active.delete(controller);
  }
  return true;
}
