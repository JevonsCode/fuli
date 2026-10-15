import { Readable } from 'node:stream';
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
  try {
    const upstream = await app.openProjectAgentTaskEvents({
      personalSpaceId: url.searchParams.get('personalSpaceId')
    }, { signal: controller.signal });
    response.writeHead(200, { 'content-type': 'text/event-stream',
      'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    response.off('close', disconnect);
    controller.abort();
    active.delete(controller);
  }
  return true;
}
