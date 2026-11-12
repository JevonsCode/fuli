import { isIP } from 'node:net';

import { cleanName } from './coordinator-service.js';
import { NEARBY_PROTOCOL } from './nearby-pairing.js';
import { shortFingerprint } from './protocol.js';

const PREFIX_LENGTH = 16;
const PREFIX = /^[0-9a-f]{16}$/;

// While nearby pairing is on, this computer says on the LAN that it runs FULI
// and lists the others that do. The advertisement carries only the service
// type, the name the person chose, the listening port, a 16-hex fingerprint
// prefix and the protocol version: the instance and host names are derived
// from the fingerprint, never from the computer's own name.
export function createNearbyPresence({ discovery }) {
  const seen = new Map();
  let advert = null;
  let browser = null;
  let selfPrefix = null;

  function browse(fingerprint) {
    selfPrefix = fingerprint.slice(0, PREFIX_LENGTH);
    browser ??= discovery.browse({
      onUp: (service) => {
        const entry = entryOf(service);
        if (entry && entry.fingerprint !== selfPrefix) seen.set(entry.fingerprint, entry);
      },
      onDown: (service) => { seen.delete(service.txt?.fp); },
    });
  }

  function advertise({ name, port, fingerprint }) {
    stopAdvertising();
    const prefix = fingerprint.slice(0, PREFIX_LENGTH);
    advert = discovery.advertise({ name: `FULI ${prefix}`, host: `fuli-${prefix}.local`, port,
      txt: { v: String(NEARBY_PROTOCOL), fp: prefix, n: name } });
  }

  function stopAdvertising() {
    advert?.stop();
    advert = null;
  }

  function stop() {
    stopAdvertising();
    browser?.stop();
    browser = null;
    seen.clear();
    discovery.close();
  }

  return { browse, advertise, stopAdvertising, stop, list: () => [...seen.values()], advertising: () => Boolean(advert) };
}

// Only a well-formed record of this protocol version is listed; anything else
// on the LAN under the same service type is ignored.
function entryOf(service) {
  const txt = service?.txt ?? {};
  const port = Number(service?.port);
  const addresses = [...new Set(service?.addresses ?? [])].filter((address) => isIP(address) === 4);
  if (txt.v !== String(NEARBY_PROTOCOL) || !PREFIX.test(txt.fp ?? '') || !Number.isSafeInteger(port)
    || port < 1 || port > 65535 || !addresses.length) return null;
  return { fingerprint: txt.fp, shortFingerprint: shortFingerprint(txt.fp), name: cleanName(txt.n) || `FULI ${txt.fp.slice(0, 4)}`,
    addresses, port };
}
