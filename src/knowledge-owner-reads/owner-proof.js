import { ApplicationError } from '../app/application-error.js';
import { ProviderRequestError } from '../graphiti/provider-client.js';

// The one check a console route makes before it shows the person's full
// history or a model's free text that may name any FLA's knowledge: Tonborg's
// judgments and suggestions (src/judgment/http.js) and the built-in Agents'
// suggestion log (src/model-backends/http.js) (rec#11 D-60), consistent with
// the console's other full reads. The route first refuses any request that is
// not loopback (refuseRemoteDecision), a LAN device with a valid LAN code
// included; then this confirms the console server's own human-review proof
// with the Provider through the owner-read port (console-port.js
// confirmOwner: one bounded read whose answer is not used).
//
// The Provider's answer decides: its refusal of the proof (401, 403) and its
// own failures pass on as they are. A port that could not send a proof at all
// (no local installation, no human-review token) is no proof: 403
// human_review_proof_required.
//
// The HTTP caller does not supply the proof: the server reads the token from
// its provider env and attaches it itself, but only for a request of the
// console session that `fuli open` started (rec#11 D-61). Without one the
// port refuses every call with 401 console_session_required
// (src/console-session/session-ports.js), which passes on as it is, before
// any proof is sent.
// what: what the route shows, for the refusal's message.
export async function confirmConsoleOwner(ownerReads, personalSpaceId, what) {
  const proofRequired = () => new ApplicationError('human_review_proof_required',
    `${what} are read only by the local console with its human-review proof`, { status: 403 });
  if (!ownerReads || !personalSpaceId) throw proofRequired();
  try {
    await ownerReads.confirmOwner(personalSpaceId);
  } catch (error) {
    if (error instanceof ProviderRequestError || error instanceof ApplicationError) throw error;
    throw proofRequired();
  }
}
