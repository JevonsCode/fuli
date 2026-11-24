import { delegatedCall } from '../http/agent-delegation-gate.js';
import { readJson, sendJson } from '../http/response.js';
import { handlePeerControlRequest } from '../../packages/roundtable/src/peer/control.js';
import { PeerError } from '../../packages/roundtable/src/peer/protocol.js';

// FULI serves the Roundtable package's peer controls on its local console.
export function handlePeerApiRequest({ request, response, url, peer }) {
  const confirmedByAgent = url.pathname === '/api/peer/nearby/confirm' && delegatedCall(request);
  return handlePeerControlRequest({ request, response, url, peer, sendJson,
    readJson: confirmedByAgent ? readNamedDevice : readJson,
    unavailableMessage: 'The LAN roundtable needs a local FULI installation' });
}

// An Agent read the code from this computer, so the code proves nothing: it names the device
// it was asked to pair with, and the pairing checks that (rec issue 135).
async function readNamedDevice(request) {
  const body = await readJson(request);
  if (typeof body?.fingerprint !== 'string') {
    throw new PeerError('device_required', 'Pass fingerprint: the device the person asked you to pair with, from the nearby list or from them', 422);
  }
  return body;
}
