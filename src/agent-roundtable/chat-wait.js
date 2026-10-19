// Subscribe before the first read, and always read again after a signal. A
// membership removal wakes the same subscription and is checked by read.
// The file signal from another process can be lost (macOS drops events written
// just after a watcher starts), so the store is also re-read every few seconds;
// SQLite stays the only source of truth.
export function waitForChatChange(read, { store, timeoutSeconds, signal, ready, recheckMs = 2000 }) {
  return new Promise((resolve, reject) => {
    let done = false, running = false, again = false, expired = false;
    let unsubscribe = () => {}, timer, recheck;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); clearInterval(recheck); unsubscribe(); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason ?? new Error('Chat wait cancelled'));
    const check = async error => {
      if (done) return;
      if (error) return finish(error);
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const page = await read();
          if (ready(page) || expired) return finish(null, page);
        } while (again && !done);
      } catch (error) { finish(error); }
      finally { running = false; }
    };
    unsubscribe = store.subscribe(check);
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutSeconds !== undefined) timer = setTimeout(() => { expired = true; void check(); }, timeoutSeconds * 1000);
    if (recheckMs > 0) recheck = setInterval(() => void check(), recheckMs);
    if (signal?.aborted) abort(); else void check();
  });
}
