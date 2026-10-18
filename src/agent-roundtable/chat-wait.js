// Subscribe before the first read, and always read again after a signal. A
// membership removal wakes the same subscription and is checked by read.
export function waitForChatChange(read, { store, timeoutSeconds, signal, ready }) {
  return new Promise((resolve, reject) => {
    let done = false, running = false, again = false, expired = false;
    let unsubscribe = () => {}, timer;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
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
    if (signal?.aborted) abort(); else void check();
  });
}
