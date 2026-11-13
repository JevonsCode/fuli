import { Bonjour } from 'bonjour-service';

export const NEARBY_SERVICE_TYPE = 'fuli-peer';

// mDNS / DNS-SD over the maintained bonjour-service library (MIT, pure
// JavaScript). Nothing binds the multicast socket until something is
// advertised or browsed, so a FULI with nearby pairing off sends nothing.
//
// One mDNS endpoint per physical LAN adapter (`adapters()`): left to itself the
// library sends from whichever adapter the system prefers, and a VPN or a
// virtual-machine adapter with a better metric then takes every query and
// announcement while the real LAN hears nothing. With no physical adapter
// there is one endpoint on the system's default.
//
// The multicast socket failing to bind (UDP 5353 taken or not allowed) is an
// 'error' event that would end the process: it goes to onFailure instead, and
// the caller turns nearby pairing off. Sending into a network that went away
// (an interface down, sleep and wake) is only a warning; mDNS retries itself.
export function createBonjourDiscovery({ onFailure = () => {}, options = undefined, adapters = () => [] } = {}) {
  let endpoints = null;
  const open = () => {
    if (endpoints) return endpoints;
    const targets = options ? [options] : adapters().map((address) => ({ interface: address }));
    const created = (targets.length ? targets : [undefined]).map((target) => new Bonjour(target, () => {}));
    for (const endpoint of created) {
      const mdns = endpoint.server?.mdns;
      mdns?.on('error', (error) => {
        if (endpoints !== created) return;
        endpoints = null;
        for (const each of created) quietly(() => each.destroy());
        onFailure(error);
      });
      mdns?.on('warning', () => {});
    }
    endpoints = created;
    return created;
  };
  return {
    // addresses: the only IPv4 addresses announced for this computer (others
    // such as virtual adapters are left out); null announces every one.
    advertise({ name, host, port, txt, addresses = null }) {
      const services = open().map((endpoint) => {
        // The library first asks the network whether the name is taken and
        // only then reads the records, so the filter below is in place in time.
        const service = endpoint.publish({ name, host, port, txt, type: NEARBY_SERVICE_TYPE, disableIPv6: true });
        if (addresses) {
          const allowed = new Set(addresses);
          const records = service.records.bind(service);
          service.records = () => records().filter((record) => record.type !== 'A' || allowed.has(record.data));
        }
        service.on?.('error', () => {});
        return service;
      });
      return { stop: () => { for (const service of services) quietly(() => service.stop?.()); } };
    },
    browse({ onUp, onDown }) {
      let browsers = [];
      // The addresses the computer announces (its physical LAN ones) come
      // before the one its packet arrived from, which may be a virtual adapter.
      const view = (service) => ({ name: service.name, port: service.port, txt: service.txt ?? {},
        addresses: [...(service.addresses ?? []), service.referer?.address].filter(Boolean) });
      const stop = () => { for (const browser of browsers.splice(0)) quietly(() => browser.stop()); };
      const start = () => {
        browsers = open().map((endpoint) => {
          const browser = endpoint.find({ type: NEARBY_SERVICE_TYPE });
          browser.on('up', (service) => onUp(view(service)));
          browser.on('txt-update', (service) => onUp(view(service)));
          browser.on('srv-update', (service) => onUp(view(service)));
          browser.on('down', (service) => onDown(view(service)));
          return browser;
        });
      };
      start();
      return {
        stop,
        // Fresh browsers ask again, so every computer still there answers anew.
        refresh: () => { stop(); quietly(start); },
      };
    },
    close() {
      const current = endpoints ?? [];
      endpoints = null;
      for (const endpoint of current) quietly(() => endpoint.destroy());
    },
  };
}

function quietly(work) {
  try { work(); } catch { /* the socket is already gone */ }
}
