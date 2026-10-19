import { readJson, sendJson } from '../http/response.js';
import { handlePeerControlRequest } from '../../packages/roundtable/src/peer/control.js';

// FULI serves the Roundtable package's peer controls on its local console.
export function handlePeerApiRequest({ request, response, url, peer }) {
  return handlePeerControlRequest({ request, response, url, peer, readJson, sendJson,
    unavailableMessage: 'The LAN roundtable needs a local FULI installation' });
}
