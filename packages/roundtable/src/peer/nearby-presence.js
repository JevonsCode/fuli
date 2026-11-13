import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

import { cleanName } from './coordinator-service.js';
import { NEARBY_PROTOCOL } from './nearby-pairing.js';
import { shortFingerprint } from './protocol.js';

const PREFIX_LENGTH = 16;
const PREFIX = /^[0-9a-f]{16}$/;
// At most this many other computers are listed; the least recently seen goes first.
const LIST_LIMIT = 32;
const ADDRESS_LIMIT = 8;
// Every computer still there answers a fresh query this often; one that has
// not answered for longer than STALE_MS is no longer listed.
const REFRESH_MS = 60_000;
const STALE_MS = 150_000;

// While nearby pairing is on, this computer says on the LAN that it runs FULI
// and lists the others that do. The advertisement carries the service type,
// the name the person chose, the listening port, a 16-hex fingerprint prefix
// and the protocol version. The instance and host names are a random id made
// each time nearby pairing turns on, never the computer's own name; the
// fingerprint prefix stays the same while it is on, so already paired
// computers are recognised and a connection can be checked before the code.
export function createNearbyPresence({ discovery, clock = Date.now }) {
  const seen = new Map();
  let advert = null;
  let browser = null;
  let refresher = null;
  let selfPrefix = null;
  let instanceId = null;

  function browse(fingerprint) {
    selfPrefix = fingerprint.slice(0, PREFIX_LENGTH);
    if (browser) return;
    browser = discovery.browse({
      onUp: (service) => {
        const entry = entryOf(service);
        if (!entry || entry.fingerprint === selfPrefix) return;
        seen.delete(entry.fingerprint);
        seen.set(entry.fingerprint, { ...entry, seenAt: clock() });
        while (seen.size > LIST_LIMIT) seen.delete(seen.keys().next().value);
      },
      onDown: (service) => { seen.delete(service.txt?.fp); },
    });
    refresher = setInterval(() => browser?.refresh?.(), REFRESH_MS);
    refresher.unref?.();
  }

  function advertise({ name, port, fingerprint, addresses = null }) {
    stopAdvertising();
    const prefix = fingerprint.slice(0, PREFIX_LENGTH);
    instanceId ??= randomBytes(4).toString('hex');
    advert = discovery.advertise({ name: `FULI ${instanceId}`, host: `fuli-${instanceId}.local`, port, addresses,
      txt: { v: String(NEARBY_PROTOCOL), fp: prefix, n: name } });
  }

  function stopAdvertising() {
    advert?.stop();
    advert = null;
  }

  function list() {
    const now = clock();
    for (const [key, entry] of seen) if (entry.seenAt + STALE_MS <= now) seen.delete(key);
    return [...seen.values()].map(({ seenAt: _seenAt, ...entry }) => entry);
  }

  function stop() {
    stopAdvertising();
    clearInterval(refresher);
    refresher = null;
    browser?.stop();
    browser = null;
    seen.clear();
    instanceId = null;
    discovery.close();
  }

  return { browse, advertise, stopAdvertising, stop, list };
}

// Only a well-formed record of this protocol version is listed; anything else
// on the LAN under the same service type is ignored.
function entryOf(service) {
  const txt = service?.txt ?? {};
  const port = Number(service?.port);
  const addresses = [...new Set(service?.addresses ?? [])].filter((address) => isIP(address) === 4).slice(0, ADDRESS_LIMIT);
  if (txt.v !== String(NEARBY_PROTOCOL) || !PREFIX.test(txt.fp ?? '') || !Number.isSafeInteger(port)
    || port < 1 || port > 65535 || !addresses.length) return null;
  return { fingerprint: txt.fp, shortFingerprint: shortFingerprint(txt.fp), name: cleanName(txt.n) || `FULI ${txt.fp.slice(12, 16).toUpperCase()}`,
    addresses, port };
}
