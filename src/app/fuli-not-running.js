// "FULI is not running" is said only by the layer that connects to FULI's own
// console, never inferred from an error that merely carries a refused
// connection somewhere in it (review of #1076): FULI's own calls to other local
// services (a model server, a database) are refused too, and saying FULI is
// not running then sends the person to restart the wrong thing.
import { ApplicationError } from './application-error.js';

// Connection codes only. ENOENT counts only from connect() to a local socket:
// the same code from reading a missing file is no connection at all.
const REFUSED = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

export function refusedConnection(error) {
  for (let item = error, depth = 0; item && typeof item === 'object' && depth < 8; item = item.cause, depth++) {
    if (REFUSED.has(item.code) || (item.code === 'ENOENT' && item.syscall === 'connect')) return true;
  }
  return false;
}

// The error a caller of FULI's own console raises when that console refused
// the connection: before anything was sent, so nothing was done. next: what
// the Agent may do about it in this data directory (unavailable-guidance.js),
// shown instead of the general next step.
export function fuliNotRunning(next = '') {
  const error = new ApplicationError('fuli_not_running',
    'FULI did not answer on this computer (connection refused): it is not running, so nothing was done.');
  if (next) error.next = next;
  return error;
}
