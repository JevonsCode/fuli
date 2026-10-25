import { readJson, sendJson } from '../http/response.js';
import { handlePeerControlRequest } from '../../packages/roundtable/src/peer/control.js';
import { requireConsoleSession } from '../console-session/session-ports.js';

// FULI serves the Roundtable package's peer controls on its local console.
// A change of where data can go (coordinator, invitation, join, shares) also
// needs the console session or, from `fuli peer`, the data directory's
// human-review token (rec#11 D-61); ownerChangeAllowed is that check, made
// by the server. Status, revoke and off answer as before.
export function handlePeerApiRequest({ request, response, url, peer, ownerChangeAllowed = false }) {
  return handlePeerControlRequest({ request, response, url, peer, readJson, sendJson,
    unavailableMessage: 'The LAN roundtable needs a local FULI installation',
    authorizeChange: () => requireConsoleSession(ownerChangeAllowed) });
}
