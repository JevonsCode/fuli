import { knownProjects, routeOfCall } from './call-routes.js';
import { failure, TASK_ENTRY_TOOLS, taskTokenOf } from './offline-calls.js';
import { hostOwner, LOCAL_OWNER, ownerFingerprint } from './routes-store.js';

// What the follower's MCP server (runner-mcp.js) asks the routes for each call
// (docs/runner-roles-design.md §4). With `global → host` and `default → host` —
// what a runner of an earlier version becomes — every call belongs to the
// paired host and nothing here changes what happens. It refuses rather than
// writing one computer's scope into another's:
//
// - a scope this computer owns: nothing writes such a route until owning
//   scopes on a follower is built (step 3; `fuli routes local` refuses it), so
//   only a store edited by hand or written by a later version gets here;
// - a scope routed to a host this computer is no longer paired with;
// - a call under a task another computer entered, which this computer can no
//   longer reach — its checkpoint must go back to the computer that entered it.
//
// input: the call's arguments (through fuli_call, its input), with the task
// token as its issuer wrote it; issuer: the issuer its token named, if any.
export function routeRefusal({ routes, store, input, issuer = null }) {
  const { scope, owner, byTask } = routeOfCall(routes, input ?? {}, { known: knownProjects(store, routes), issuer });
  const paired = store.host()?.fingerprint?.toLowerCase() ?? null;
  if (issuer) {
    return !paired || paired.startsWith(issuer) ? null : failure('task_owner_not_paired', ENTERED_ELSEWHERE);
  }
  if (owner === LOCAL_OWNER) {
    return failure('scope_owned_here', `${scope} is routed to this computer, which cannot answer a scope it follows a host `
      + 'for yet (owning scopes on a computer that follows a host is not built yet). Point it at the host again with '
      + `\`fuli routes follow ${scope} <host>\`; \`fuli routes list\` shows every route.`);
  }
  // No pairing at all: the follower already answers that (runner_not_paired).
  if (!paired || ownerFingerprint(owner) === paired) return null;
  return byTask
    ? failure('task_owner_not_paired', ENTERED_ELSEWHERE)
    : failure('scope_owner_not_paired', `${scope} belongs to a computer this one is no longer paired with. `
      + `\`fuli routes list\` shows it; \`fuli routes follow ${scope} <host>\` points it at the host paired now.`);
}

const ENTERED_ELSEWHERE = 'This task was entered on a computer this one is no longer paired with, so the call cannot '
  + 'go back to it. Enter the task again with get_collaboration_preferences and use the token it gives.';

// A task entry the host answered: its token is that host's, so whatever the
// routes become, the calls and the checkpoint of that task go back there.
export function rememberTaskOwner({ routes, store, tool, answer }) {
  if (!TASK_ENTRY_TOOLS.has(tool) || answer?.isError) return;
  const token = taskTokenOf(answer);
  const fingerprint = store.host()?.fingerprint;
  if (token && fingerprint) routes.rememberTaskOwner(token, hostOwner(fingerprint));
}
