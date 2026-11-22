import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { certificateFingerprint } from '../../packages/roundtable/src/peer/device-identity.js';

// Which computer issued a receipt's links (rec#146 item 3).
//
// The links themselves stay loopback and are not rewritten: that is what opens
// in one click here, and a runner's follower console deliberately serves its
// host's console at this computer's own loopback and port, so the links a host
// hands out already open there (src/runner/follower-console.js). What was
// missing is which computer a link belongs to, so a reply forwarded to someone
// else, or read on a computer paired to a different host, showed a bare
// 127.0.0.1 with nothing to say where it lives.
//
// So the receipt names its issuing computer in a field of its own rather than
// in the visible line: no reply gets longer, and a reader — a person, or a
// follower proxy mapping a host to its own /remote/<host>/ route — can tell
// whose console the link is. The value is this installation's device
// fingerprint, the same identity a runner pairs with
// (packages/roundtable/src/peer/device-identity.js), so both sides already
// agree on it.
//
// Read once, read-only: the certificate is created when the person sets up
// pairing, never by a receipt. An installation that has never paired has no
// fingerprint, and the receipt then names no host rather than inventing one.
const CERT_FILE = 'peer/device-cert.pem';
// Enough to name one computer among a person's own; the whole fingerprint
// stays where pairing checks it.
const SHORT = 16;

const cached = new Map();

export function receiptHost(application) {
  // The same data directory the rest of the installation uses
  // (federated-application.js derives it from the runtime config path).
  const runtimeConfigPath = application?.runtimeConfigPath;
  const dataDir = typeof runtimeConfigPath === 'string' && runtimeConfigPath ? dirname(runtimeConfigPath) : null;
  if (!dataDir) return null;
  if (!cached.has(dataDir)) cached.set(dataDir, readFingerprint(dataDir));
  const fingerprint = cached.get(dataDir);
  return fingerprint ? { fingerprint } : null;
}

function readFingerprint(dataDir) {
  try {
    const path = join(dataDir, CERT_FILE);
    if (!existsSync(path)) return null;
    return certificateFingerprint(readFileSync(path, 'utf8')).slice(0, SHORT);
  } catch {
    // An unreadable certificate names no host; it never fails a receipt.
    return null;
  }
}

// Tests and a changed data directory re-read the file.
export function forgetReceiptHost() {
  cached.clear();
}
