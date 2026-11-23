import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { ApplicationError } from '../app/application-error.js';
import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';
import { callScope, describeRoutes, knownProjects, openRoutes } from '../runner/call-routes.js';
import { GLOBAL_SCOPE, hostOwner, LOCAL_OWNER, PROJECT_PREFIX, scopeName } from '../runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../runner/runner-store.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { localConsoleUrl } from './console-url.js';
import { writeLine } from './terminal-io.js';

// `fuli routes` (docs/runner-roles-design.md §3): which parts of the person's
// FULI this computer reads and writes on another one. `fuli runner join` keeps
// working and is 「follow everything」; these commands change one scope at a
// time. A computer with no routes is a plain FULI and says so.
const USAGE = `fuli routes <action>  (Beta. Which parts of your FULI this computer follows on another)
    list                          every scope, who owns it, and when a read-only copy here was synced
    follow SCOPE HOST             read and write that scope on HOST (the paired host's name, or the
                                  start of its fingerprint; \`fuli runner status\` names it)
    local SCOPE                   own that scope on this computer (not built yet: refused, says why)
    scope-of PATH                 which scope a call in that folder belongs to
  SCOPE is \`global\`, \`default\`, or \`project:<id>\`, a project's id as the host names it;
  \`fuli routes scope-of PATH\` prints the scope of a folder by the host's own rules.
  Every action takes --data-dir DIR.`;
// Owning a scope here means answering its calls from this computer's own FULI,
// which a computer that follows a host does not have yet (step 3 of the design).
// Owning a scope on a computer that follows a host is step 3 of the design; until it is built, no
// route says `local`, whatever this computer has (a FULI of its own beside a pairing is normal), so no
// store of this version holds a second owner for a scope when step 3 arrives.
const LOCAL_NOT_YET = 'Owning a scope on a computer that follows a host is not built yet '
  + '(docs/runner-roles-design.md, step 3), so no scope is routed to this computer for now. What works now: '
  + '`fuli routes list` shows what this computer follows, `fuli routes follow SCOPE HOST` points a scope at the paired '
  + 'host, and `fuli runner leave` makes this computer own everything it has again.';
// `global` (habits, profile, the FLA roster) has one owner, the host's, always (D1, D2).
const GLOBAL_STAYS = '`global` (your habits, profile and the FLA roster) has one owner, the computer you follow; '
  + 'it is never owned by a computer that follows another (docs/runner-roles-design.md D1, D2).';

export async function runRoutesCommand(args, { env = process.env, write = writeLine, fetchImpl = fetch,
  readConfig = readGraphRuntimeConfig } = {}) {
  const [action, ...rest] = args;
  const dataDir = option(rest, '--data-dir');
  const paths = resolveSetupPaths({ dataDir, env });
  if (!action || action === '--help' || action === '-h') return void write(USAGE);
  const routes = openRoutes(paths.dataDir);
  const runner = new RunnerStore(join(paths.dataDir, RUNNER_FILE));
  try {
    if (action === 'scope-of') {
      const folder = named(rest);
      if (!folder) throw new TypeError(`Missing PATH\n${USAGE}`);
      // The same answer a call in that folder gets (call-routes.js).
      // A relative path is the person's, from where they run the command: made absolute here, as a client's would be.
      write(callScope(resolvePath(process.cwd(), folder), { known: knownProjects(runner, routes) }));
      return { exitCode: 0 };
    }
    const host = runner.host();
    if (action === 'list') {
      const listed = describeRoutes(routes, { hostName: host?.name ?? null, hostFingerprint: host?.fingerprint ?? null });
      for (const row of listed) {
        write(`  ${row.scope.padEnd(28)} ${row.ownerName}`
          + (row.replica ? `  (a read-only copy here, synced ${row.replicaSyncedAt ?? 'never'})` : ''));
      }
      if (listed.every((row) => row.owner === LOCAL_OWNER)) {
        write('This computer owns everything it has; it follows no other computer.');
      }
      return { exitCode: 0 };
    }
    const scope = scopeName(named(rest));
    if (!scope) throw new TypeError(`SCOPE must be \`global\`, \`default\` or \`project:<id>\`\n${USAGE}`);
    if (action === 'follow') {
      const asked = named(rest, 1);
      if (!asked) throw new TypeError(`Missing HOST\n${USAGE}`);
      if (!host) throw new ApplicationError('not_paired', 'This computer is paired with no host. '
        + 'Run `fuli runner invite` on the computer that holds your FULI and `fuli runner join` here.');
      if (!namesHost(asked, host)) {
        throw new ApplicationError('unknown_host', `This computer is paired with ${host.name} only `
          + `(${host.fingerprint.slice(0, 16)}), not with ${asked}.`);
      }
      // A scope this computer already has data of is not followed elsewhere: that data would be hidden,
      // and two computers would hold one scope (design §7.1). Moving a scope is a later step.
      const local = await localScopeData({ dataDir: paths.dataDir, env, scope, fetchImpl, readConfig });
      if (local) throw new ApplicationError(local.code, local.message);
      routes.set(scope, hostOwner(host.fingerprint));
      write(`${scope} → ${host.name}. Calls in that scope now read and write there.`);
      return { exitCode: 0 };
    }
    if (action === 'local') {
      if (scope === GLOBAL_SCOPE) throw new ApplicationError('global_has_one_owner', GLOBAL_STAYS);
      throw new ApplicationError('local_route_not_yet', LOCAL_NOT_YET);
    }
    throw new TypeError(`Unknown routes action: ${action}\n${USAGE}`);
  } finally {
    runner.close();
    routes.close();
  }
}

// Whether this computer has data of this scope already: null when it has none
// (no FULI of its own, or one without that project), else why it is refused.
// The project list is the running console's own (`GET /api/personal-projects`
// for this data directory's personal space); a console that cannot be reached
// and one that answered with an error are said apart.
async function localScopeData({ dataDir, env, scope, fetchImpl, readConfig = readGraphRuntimeConfig }) {
  const configPath = join(dataDir, 'graph-runtime.json');
  if (!existsSync(configPath)) return null;
  if (!scope.startsWith(PROJECT_PREFIX)) {
    return { code: 'scope_has_local_data', message: `This computer holds a FULI of its own, with its own ${scope} data; `
      + 'following a host for it would hide that data, and moving a scope between computers is not built yet '
      + '(docs/runner-roles-design.md §7). Nothing was changed.' };
  }
  const id = scope.slice(PROJECT_PREFIX.length);
  let spaceId;
  try { spaceId = readConfig(configPath).personal.spaceId; } catch (error) {
    return { code: 'local_fuli_unreadable', message: `This computer's own FULI settings (graph-runtime.json) could not be `
      + `read (${String(error?.message ?? error).slice(0, 200)}), so it cannot be checked for project ${id}. `
      + '`fuli doctor` says what is wrong. Nothing was changed.' };
  }
  const url = new URL('/api/personal-projects', localConsoleUrl({ dataDir, env }));
  url.searchParams.set('personalSpaceId', spaceId);
  let answer;
  try { answer = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) }); } catch {
    return { code: 'local_fuli_not_running', message: 'This computer holds a FULI of its own, which must be running so '
      + `it can be checked for project ${id} before that project is followed elsewhere: start it with \`fuli start\`, `
      + 'then run this again. Nothing was changed.' };
  }
  let body = null;
  try { body = await answer.json(); } catch { body = null; }
  if (!answer.ok) {
    return { code: 'local_fuli_refused', message: `This computer's own FULI answered but could not list its projects `
      + `(HTTP ${answer.status}${body?.error ? `: ${body.error}` : ''}), so it cannot be checked for project ${id}. `
      + '`fuli status` and `fuli diagnostics` say why. Nothing was changed.' };
  }
  const projects = Array.isArray(body) ? body : Array.isArray(body?.projects) ? body.projects : [];
  if (!projects.some((project) => project?.project_id === id)) return null;
  return { code: 'scope_has_local_data', message: `This computer's own FULI already has project ${id}; following a host `
    + 'for it would hide that project here, and moving a project between computers is not built yet '
    + '(docs/runner-roles-design.md §7). Nothing was changed.' };
}

// The host as the person names it: its own name, or the start of the fingerprint the pairing pinned.
function namesHost(asked, host) {
  const value = String(asked).toLowerCase();
  return value === host.name.toLowerCase()
    || (value.length >= 8 && host.fingerprint.toLowerCase().startsWith(value));
}

function named(args, skip = 0) {
  const values = args.filter((value, index) => !value.startsWith('--') && args[index - 1] !== '--data-dir');
  return values[skip];
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}
