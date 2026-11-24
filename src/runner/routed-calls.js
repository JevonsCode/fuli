import { knownProjects, routeOfCall } from './call-routes.js';
import { entryToken, failure, isTaskEntry, resultValue } from './offline-calls.js';
import { hostOwner, LOCAL_OWNER, ownerFingerprint, PROJECT_PREFIX } from './routes-store.js';

// Where the follower's MCP server (runner-mcp.js) sends each call, by the
// routes (docs/runner-roles-design.md §4), decided before anything is sent.
// With `global → host` and `default → host`, what a runner of an earlier
// version becomes, every call belongs to the paired host and nothing here
// changes what happens. Answers { to: 'host' }, { to: 'local', scope } (this
// computer's own half, local-scope-server.js), or { refused } rather than
// writing one computer's scope into another's:
//
// - a project routed to this computer by a route of its own (`fuli routes
//   local`, make-project-local.js), or a task this computer entered (its token
//   remembered as entered here): answered here. Only such a route says so: a
//   scope with no route of its own, `default` included, is not this
//   computer's for want of one, and a token naming this computer whose task
//   was not remembered here goes as it went before;
// - `global` or `default` routed to this computer: a follower never owns them
//   (local-route-refusal.js), so only a store edited by hand gets here;
// - a scope routed to a host this computer is no longer paired with;
// - a call under a task another computer entered, which this computer can no
//   longer reach — its checkpoint must go back to the computer that entered it.
//
// input: the call's arguments (through fuli_call, its input), with the task
// token as its issuer wrote it; issuer: the issuer its token named, if any;
// ownIssuer: the start of this computer's own fingerprint (task-issuer.js ownIssuer).
export function callDestination({ routes, store, input, issuer = null, ownIssuer = null }) {
  const { scope, owner, byTask } = routeOfCall(routes, input ?? {}, { known: knownProjects(store, routes), issuer });
  const paired = store.host()?.fingerprint?.toLowerCase() ?? null;
  const routedHere = scope.startsWith(PROJECT_PREFIX) && routes.routedHere(scope);
  if (issuer) {
    if (ownIssuer && issuer === ownIssuer && (routedHere || routes.taskOwner(input?.taskContextToken) === LOCAL_OWNER)) {
      return { to: 'local', scope };
    }
    return !paired || paired.startsWith(issuer) ? HOST : { refused: failure('task_owner_not_paired', ENTERED_ELSEWHERE) };
  }
  if (owner === LOCAL_OWNER) {
    if (byTask || routedHere) return { to: 'local', scope };
    return { refused: failure('scope_owned_here', `${scope} is routed to this computer, which never owns it while it follows `
      + `a host (docs/runner-roles-design.md D1, D2). Point it at the host again with \`fuli routes follow ${scope} <host>\`; `
      + '`fuli routes list` shows every route.') };
  }
  // No pairing at all: the follower already answers that (runner_not_paired).
  if (!paired || ownerFingerprint(owner) === paired) return HOST;
  return { refused: byTask
    ? failure('task_owner_not_paired', ENTERED_ELSEWHERE)
    : failure('scope_owner_not_paired', `${scope} belongs to a computer this one is no longer paired with. `
      + `\`fuli routes list\` shows it; \`fuli routes follow ${scope} <host>\` points it at the host paired now.`) };
}

const HOST = Object.freeze({ to: 'host' });

const ENTERED_ELSEWHERE = 'This task was entered on a computer this one is no longer paired with, so the call cannot '
  + 'go back to it. Enter the task again with get_collaboration_preferences and use the token it gives.';

// A task entry the host answered, or this computer (local: true): its token is
// that computer's, so whatever the routes become, the calls and the checkpoint
// of that task go back there, a token passed without its issuer too.
export function rememberTaskOwner({ routes, store, tool, answer, local = false }) {
  if (!isTaskEntry(tool) || answer?.isError) return;
  const token = entryToken(resultValue(answer));
  const fingerprint = store.host()?.fingerprint;
  if (token && local) routes.rememberTaskOwner(token, LOCAL_OWNER);
  else if (token && fingerprint) routes.rememberTaskOwner(token, hostOwner(fingerprint));
}

// The routes could not be read, so no call can be told where it goes: said as
// it is, with what to do, instead of the server failing to start.
export function routesUnavailableAnswer(error) {
  const reason = typeof error?.code === 'string' ? error.code : 'routes_unreadable';
  const detail = String(error?.message ?? error).slice(0, 400);
  return failure('routes_unavailable', 'This computer cannot read which parts of your FULI it follows '
    + `(runner/routes.sqlite: ${detail}), so no call is sent anywhere until that is fixed. If a newer FULI wrote it, `
    + 'update FULI on this computer (`fuli update`); `fuli migrate status` says what the store needs; or end the '
    + 'pairing and join again (`fuli runner leave`, then `fuli runner join`).', { reason });
}
