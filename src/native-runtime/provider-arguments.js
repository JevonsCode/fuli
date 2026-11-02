// How the Graph Provider is served, the same on every platform. Its access
// log is off: request paths carry task-context tokens, which must not end up
// in a log file someone may copy or attach to a report (REC #66). Errors
// still reach the log.
export function providerServerArguments(port) {
  return ['-m', 'uvicorn', 'fuli_graph.app:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'];
}
