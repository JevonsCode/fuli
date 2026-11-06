// SIGINT and SIGTERM end the console process within a bounded time (rec#94).
// A graceful close waits for every open request and every resource; an
// in-flight request or a resource that never finishes closing left the
// process alive with its listener closed, so nothing could start a new
// console. After dropConnectionsMs open connections are cut; after exitMs the
// process exits whatever is still closing. A second signal exits at once.

const SIGNAL_SHUTDOWN_LIMITS = Object.freeze({ dropConnectionsMs: 3_000, exitMs: 10_000 });

export function exitOnSignals({ server, close, target = process, exit = code => process.exit(code),
  log = message => console.error(message), limits = SIGNAL_SHUTDOWN_LIMITS }) {
  let shuttingDown = false;
  const handler = (signal) => {
    if (shuttingDown) {
      log(`${signal} received again; exiting now.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    setTimeout(() => server.closeAllConnections?.(), limits.dropConnectionsMs).unref();
    setTimeout(() => {
      log(`Server shutdown did not finish within ${limits.exitMs / 1000} s; exiting.`);
      exit(1);
    }, limits.exitMs).unref();
    close().then(() => exit(target.exitCode ?? 0), (error) => {
      log(`Server shutdown failed: ${error.message}`);
      exit(1);
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) target.on(signal, handler);
}
