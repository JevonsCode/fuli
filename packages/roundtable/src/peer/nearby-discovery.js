import { Bonjour } from 'bonjour-service';

export const NEARBY_SERVICE_TYPE = 'fuli-peer';

// mDNS / DNS-SD over the maintained bonjour-service library (MIT, pure
// JavaScript). Nothing binds the multicast socket until something is
// advertised or browsed, so a FULI with nearby pairing off sends nothing.
//
// One mDNS endpoint per physical LAN adapter (`adapters()`): left to itself the
// library sends from whichever adapter the system prefers, and a VPN or a
// virtual-machine adapter with a better metric then takes every query and
// announcement while the real LAN hears nothing. Each endpoint joins and sends
// on its adapter but binds every address: macOS and Linux deliver multicast
// only to a socket bound that way. With no physical adapter there is one
// endpoint on the system's default. The adapters are read again at each
// refresh, so a computer that changed network is found again.
//
// A multicast socket that fails (UDP 5353 taken or not allowed) is an 'error'
// event that would end the process. That endpoint is dropped; when none is
// left the error goes to onFailure and the caller turns nearby pairing off.
// Sending into a network that went away (an interface down, sleep and wake) is
// only a warning; mDNS retries itself.
export function createBonjourDiscovery({ onFailure = () => {}, options = undefined, adapters = () => [],
  create = (target) => new Bonjour(target, () => {}) } = {}) {
  let endpoints = null;
  let opened = '';
  let advert = null;
  let watch = null;

  const targets = () => (options ? [options] : adapters().map((address) => ({ interface: address, bind: '0.0.0.0' })));
  const open = () => {
    if (endpoints) return endpoints;
    const wanted = targets();
    const created = (wanted.length ? wanted : [undefined]).map((target) => ({ bonjour: create(target), service: null, browser: null }));
    for (const endpoint of created) {
      const mdns = endpoint.bonjour.server?.mdns;
      mdns?.on('error', (error) => {
        if (endpoints !== created || !created.includes(endpoint)) return;
        created.splice(created.indexOf(endpoint), 1);
        quietly(() => endpoint.bonjour.destroy());
        if (created.length) return;
        endpoints = null;
        onFailure(error);
      });
      mdns?.on('warning', () => {});
    }
    endpoints = created;
    opened = JSON.stringify(wanted);
    return created;
  };
  const shut = () => {
    const current = endpoints ?? [];
    endpoints = null;
    for (const endpoint of current) quietly(() => endpoint.bonjour.destroy());
  };

  // The address filter is installed right after publish: the library first
  // asks the network whether the name is taken and only then reads the records.
  // Every endpoint has its own instance name, so two adapters on one LAN (wired
  // and Wi-Fi) never take each other for a name already in use.
  const publish = () => {
    if (!advert) return;
    open().forEach((endpoint, index) => {
      const suffix = index ? `-${index + 1}` : '';
      const service = endpoint.bonjour.publish({ name: `${advert.name}${suffix}`, host: advert.host.replace(/(\.local)?$/, `${suffix}$1`),
        port: advert.port, txt: advert.txt, type: NEARBY_SERVICE_TYPE, disableIPv6: true });
      if (advert.addresses) {
        const allowed = new Set(advert.addresses);
        const records = service.records.bind(service);
        service.records = () => records().filter((record) => record.type !== 'A' || allowed.has(record.data));
      }
      service.on?.('error', () => {});
      endpoint.service = service;
    });
  };
  const unpublish = () => {
    for (const endpoint of endpoints ?? []) { const { service } = endpoint; endpoint.service = null; quietly(() => service?.stop?.()); }
  };

  // The addresses the computer announces (its physical LAN ones) come before
  // the one its packet arrived from, which may be a virtual adapter.
  const view = (service) => ({ name: service.name, port: service.port, txt: service.txt ?? {},
    addresses: [...(service.addresses ?? []), service.referer?.address].filter(Boolean) });
  const look = () => {
    if (!watch) return;
    for (const endpoint of open()) {
      const browser = endpoint.bonjour.find({ type: NEARBY_SERVICE_TYPE });
      browser.on('up', (service) => watch.onUp(view(service)));
      browser.on('txt-update', (service) => watch.onUp(view(service)));
      browser.on('srv-update', (service) => watch.onUp(view(service)));
      browser.on('down', (service) => watch.onDown(view(service)));
      endpoint.browser = browser;
    }
  };
  const unlook = () => {
    for (const endpoint of endpoints ?? []) { const { browser } = endpoint; endpoint.browser = null; quietly(() => browser?.stop()); }
  };

  return {
    // addresses: the only IPv4 addresses announced for this computer (others
    // such as virtual adapters are left out); null announces every one.
    advertise({ name, host, port, txt, addresses = null }) {
      unpublish();
      advert = { name, host, port, txt, addresses };
      publish();
      return { stop: () => { advert = null; unpublish(); } };
    },
    browse({ onUp, onDown }) {
      watch = { onUp, onDown };
      look();
      return {
        stop: () => { watch = null; unlook(); },
        // Fresh browsers ask again, so every computer still there answers
        // anew; on adapters that changed, everything starts over.
        refresh: () => quietly(() => {
          if (endpoints && JSON.stringify(targets()) !== opened) { shut(); publish(); }
          else unlook();
          look();
        }),
      };
    },
    close() {
      advert = null;
      watch = null;
      shut();
    },
  };
}

function quietly(work) {
  try { work(); } catch { /* the socket is already gone */ }
}
