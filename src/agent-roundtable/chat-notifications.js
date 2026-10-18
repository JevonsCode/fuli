import { EventEmitter } from 'node:events';
import { realpathSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const channels = new Map();

// A commit signal, never a message transport. Share synchronous notifications
// between connections in this process; the native file signal reaches other
// MCP/console processes. SQLite remains authoritative when events coalesce.
export function createChatNotifications(path) {
  const key = path === ':memory:' ? Symbol() : realpathSync(path);
  const marker = typeof key === 'string' ? `${key}.chat-signal` : null;
  let channel = channels.get(key);
  if (!channel) {
    const events = new EventEmitter(); events.setMaxListeners(0);
    channel = { events, owners: 0, watcher: null };
    channels.set(key, channel);
  }
  channel.owners++;
  const listeners = new Set();
  let closed = false;
  function stopWatching() {
    if (!channel.events.listenerCount('change')) { channel.watcher?.close(); channel.watcher = null; }
  }
  return {
    subscribe(listener) {
      if (closed) throw new Error('Chat store closed');
      if (marker && !channel.watcher) {
        channel.watcher = watch(dirname(marker), (_event, file) => {
          if (String(file) === basename(marker)) channel.events.emit('change');
        });
        channel.watcher.on('error', error => channel.events.emit('change', error));
      }
      listeners.add(listener); channel.events.on('change', listener);
      return () => { listeners.delete(listener); channel.events.off('change', listener); stopWatching(); };
    },
    publish() {
      if (marker) writeFileSync(marker, randomUUID(), { mode: 0o600 });
      channel.events.emit('change');
    },
    close() {
      if (closed) return;
      closed = true;
      for (const listener of listeners) {
        listener(new Error('Chat store closed'));
        channel.events.off('change', listener);
      }
      listeners.clear(); stopWatching();
      if (!--channel.owners) { channel.watcher?.close(); channels.delete(key); }
    }
  };
}
