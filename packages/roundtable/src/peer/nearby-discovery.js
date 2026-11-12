import { Bonjour } from 'bonjour-service';

export const NEARBY_SERVICE_TYPE = 'fuli-peer';

// mDNS / DNS-SD over the maintained bonjour-service library (MIT, pure
// JavaScript). Nothing binds the multicast socket until something is
// advertised or browsed, so a FULI with nearby pairing off sends nothing.
//
// The multicast socket failing to bind (UDP 5353 taken or not allowed) is an
// 'error' event that would end the process: it goes to onFailure instead, and
// the caller turns nearby pairing off. Sending into a network that went away
// (an interface down, sleep and wake) is only a warning; mDNS retries itself.
export function createBonjourDiscovery({ onFailure = () => {}, options = undefined } = {}) {
  let bonjour = null;
  const instance = () => {
    if (bonjour) return bonjour;
    const created = new Bonjour(options, () => {});
    const mdns = created.server?.mdns;
    mdns?.on('error', (error) => {
      if (bonjour === created) bonjour = null;
      quietly(() => created.destroy());
      onFailure(error);
    });
    mdns?.on('warning', () => {});
    bonjour = created;
    return created;
  };
  return {
    // addresses: the only IPv4 addresses announced for this computer (others
    // such as virtual adapters are left out); null announces every one.
    advertise({ name, host, port, txt, addresses = null }) {
      const service = instance().publish({ name, host, port, txt, type: NEARBY_SERVICE_TYPE, disableIPv6: true });
      if (addresses) {
        const allowed = new Set(addresses);
        const records = service.records.bind(service);
        service.records = () => records().filter((record) => record.type !== 'A' || allowed.has(record.data));
      }
      service.on?.('error', () => {});
      return { stop: () => quietly(() => service.stop?.()) };
    },
    browse({ onUp, onDown }) {
      let browser = null;
      // The addresses the computer announces (its physical LAN ones) come
      // before the one its packet arrived from, which may be a virtual adapter.
      const view = (service) => ({ name: service.name, port: service.port, txt: service.txt ?? {},
        addresses: [...(service.addresses ?? []), service.referer?.address].filter(Boolean) });
      const start = () => {
        browser = instance().find({ type: NEARBY_SERVICE_TYPE });
        browser.on('up', (service) => onUp(view(service)));
        browser.on('txt-update', (service) => onUp(view(service)));
        browser.on('srv-update', (service) => onUp(view(service)));
        browser.on('down', (service) => onDown(view(service)));
      };
      start();
      return {
        stop: () => quietly(() => browser?.stop()),
        // A fresh browser asks again, so every computer still there answers anew.
        refresh: () => { quietly(() => browser?.stop()); quietly(start); },
      };
    },
    close() {
      const current = bonjour;
      bonjour = null;
      quietly(() => current?.destroy());
    },
  };
}

function quietly(work) {
  try { work(); } catch { /* the socket is already gone */ }
}
