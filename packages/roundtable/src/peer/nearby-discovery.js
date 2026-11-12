import { Bonjour } from 'bonjour-service';

export const NEARBY_SERVICE_TYPE = 'fuli-peer';

// mDNS / DNS-SD over the maintained bonjour-service library (MIT, pure
// JavaScript). Nothing binds the multicast socket until something is
// advertised or browsed, so a FULI with nearby pairing off sends nothing.
export function createBonjourDiscovery({ onError = () => {} } = {}) {
  let bonjour = null;
  const instance = () => (bonjour ??= new Bonjour(undefined, onError));
  return {
    advertise({ name, host, port, txt }) {
      const service = instance().publish({ name, host, port, txt, type: NEARBY_SERVICE_TYPE, disableIPv6: true });
      service.on?.('error', onError);
      return { stop: () => service.stop?.() };
    },
    browse({ onUp, onDown }) {
      const browser = instance().find({ type: NEARBY_SERVICE_TYPE });
      const view = (service) => ({ name: service.name, port: service.port, txt: service.txt ?? {},
        addresses: [service.referer?.address, ...(service.addresses ?? [])].filter(Boolean) });
      browser.on('up', (service) => onUp(view(service)));
      browser.on('txt-update', (service) => onUp(view(service)));
      browser.on('srv-update', (service) => onUp(view(service)));
      browser.on('down', (service) => onDown(view(service)));
      return { stop: () => browser.stop() };
    },
    close() {
      bonjour?.destroy();
      bonjour = null;
    },
  };
}
