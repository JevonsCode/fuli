import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { ApplicationError } from '../app/application-error.js';
import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';
import { callScope, describeRoutes, knownProjects, openRoutes, projectOwners } from '../runner/call-routes.js';
import { graphHoldsNothingOfThePerson, localRuntimeLine, localRuntimeStep, PREPARING_WAIT, readLocalRuntime }
  from '../runner/follower-local-runtime.js';
import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { createHostConnection } from '../runner/host-connection.js';
import { localGraphProjects } from '../runner/local-graph-projects.js';
import { localRouteRefusal } from '../runner/local-route-refusal.js';
import { makeProjectHere } from '../runner/make-project-local.js';
import { DEFAULT_SCOPE, GLOBAL_SCOPE, hostOwner, LOCAL_OWNER, PROJECT_PREFIX, scopeName } from '../runner/routes-store.js';
import { RUNNER_FILE, RunnerStore } from '../runner/runner-store.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { writeLine } from './terminal-io.js';

// `fuli routes` (docs/runner-roles-design.md §3): which parts of the person's
// FULI this computer reads and writes on another one. `fuli runner join` keeps
// working and is 「follow everything」; these commands change one scope at a
// time. A computer with no routes is a plain FULI and says so.
const USAGE = `fuli routes <action>  (Beta. Which parts of your FULI this computer follows on another)
    list                          every scope, who owns it, and when a read-only copy here was synced
    follow SCOPE HOST             read and write that scope on HOST (the paired host's name, or the
                                  start of its fingerprint; \`fuli runner status\` names it)
    local FOLDER|project:<id>     keep a new project on this computer: one the host does not have,
                                  made here while both computers are connected (refused, with why
                                  and what to do, otherwise)
    scope-of PATH                 which scope a call in that folder belongs to
  SCOPE is \`global\`, \`default\`, or \`project:<id>\`, a project's id as the host names it;
  \`fuli routes scope-of PATH\` prints the scope of a folder by the host's own rules.
  Every action takes --data-dir DIR.`;
export async function runRoutesCommand(args, { env = process.env, write = writeLine, fetchImpl = fetch,
  readConfig = readGraphRuntimeConfig, makeHere = makeProjectHere, connect = followerConnection } = {}) {
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
        return { exitCode: 0 };
      }
      // Each project this computer knows of, and which computer it belongs to now (本机 / 主机 …).
      const projects = projectOwners(routes, runner, { hostName: host?.name ?? null, hostFingerprint: host?.fingerprint ?? null })
        .filter((project) => project.byDefault);
      if (projects.length) write('Projects without a route of their own, which go as new folders do:');
      for (const project of projects) write(`  ${project.scope.padEnd(28)} ${project.ownerName}`);
      write(localRuntimeLine(readLocalRuntime(paths.dataDir)).en);
      return { exitCode: 0 };
    }
    if (action === 'local') {
      const asked = named(rest);
      if (!asked) throw new TypeError(`Missing FOLDER or project:<id>\n${USAGE}`);
      if (!host) throw new ApplicationError('not_paired', 'This computer is paired with no host, so it owns everything '
        + 'it has already. `fuli routes list` says so.');
      const scope = scopeName(asked);
      // `global` and `default` are never this computer's (local-route-refusal.js says why).
      if (scope === GLOBAL_SCOPE || scope === DEFAULT_SCOPE) {
        const refused = localRouteRefusal({ scope, hostName: host.name });
        throw new ApplicationError(refused.code, refused.message);
      }
      const byId = asked.startsWith(PROJECT_PREFIX);
      if (byId && !scope) throw new TypeError(`project:<id> needs the id\n${USAGE}`);
      // The same way the console's 「放在这台电脑」 and the person's AI make one (make-project-local.js);
      // the host is reached only once this computer's own checks pass.
      let opened = null;
      const channel = async () => opened ??= await connect(paths.dataDir, runner);
      const connection = { connect: async (...options) => (await channel()).connect(...options),
        getText: async (...options) => (await channel()).getText(...options) };
      let kept;
      try {
        kept = await makeHere({ dataDir: paths.dataDir, store: runner, connection,
          folder: byId ? null : resolvePath(process.cwd(), asked), projectId: byId ? scope.slice(PROJECT_PREFIX.length) : null,
          sessionId: 'fuli-routes-local' });
      } finally { opened?.close(); }
      if (kept.refused) throw new ApplicationError(kept.refused.code, kept.refused.message);
      write(`${kept.scope} → this computer${kept.folder ? ` (${kept.folder})` : ''}. Its work is answered here, also while `
        + `${host.name} is away; what it writes to global still goes to ${host.name}.`);
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
      const local = await localScopeData({ dataDir: paths.dataDir, scope, fetchImpl, readConfig });
      if (local) throw new ApplicationError(local.code, local.message);
      routes.set(scope, hostOwner(host.fingerprint));
      write(`${scope} → ${host.name}. Calls in that scope now read and write there.`);
      return { exitCode: 0 };
    }
    throw new TypeError(`Unknown routes action: ${action}\n${USAGE}`);
  } finally {
    runner.close();
    routes.close();
  }
}

// Whether this computer has data of this scope already: null when it has none
// (no graph of its own, or one without that project), else why it is refused.
// This computer's graph is asked through its own Provider (local-graph-projects.js),
// never through the console port, which on a follower answers with the host's
// projects. While no scope is this computer's, that Provider is stopped; what the
// preparation found in the graph then is the answer, since nothing starts that
// graph on a follower but the preparation (follower-local-runtime.js).
async function localScopeData({ dataDir, scope, fetchImpl, readConfig = readGraphRuntimeConfig }) {
  const configPath = join(dataDir, 'graph-runtime.json');
  if (!existsSync(configPath)) return null;
  const prepared = readLocalRuntime(dataDir);
  if (!scope.startsWith(PROJECT_PREFIX)) {
    if (prepared.state === 'preparing') return { code: 'local_runtime_preparing', message: `${PREPARING_WAIT.en}\n${PREPARING_WAIT.zh}` };
    if (graphHoldsNothingOfThePerson(prepared)) return null;
    return { code: 'scope_has_local_data', message: `This computer holds a FULI of its own, with its own ${scope} data; `
      + 'following a host for it would hide that data, and moving a scope between computers is not built yet '
      + '(docs/runner-roles-design.md §7). Nothing was changed.' };
  }
  const id = scope.slice(PROJECT_PREFIX.length);
  let listed;
  try { listed = await localGraphProjects(configPath, { fetchImpl, readConfig }); } catch (error) {
    return { code: 'local_fuli_unreadable', message: `This computer's own FULI settings (graph-runtime.json) could not be `
      + `read (${String(error?.message ?? error).slice(0, 200)}), so it cannot be checked for project ${id}. `
      + '`fuli doctor` says what is wrong. Nothing was changed.' };
  }
  if (listed.refused) {
    return { code: 'local_fuli_refused', message: `This computer's own graph answered but could not list its projects `
      + `(HTTP ${listed.refused}: ${listed.code}), so it cannot be checked for project ${id}. `
      + '`fuli status` and `fuli diagnostics` say why. Nothing was changed.' };
  }
  const projects = listed.projects ?? (prepared.state === 'ready' ? prepared.projects : null);
  if (!projects) {
    return { code: 'local_fuli_not_running', message: `This computer's own graph does not answer and was never checked, so `
      + `it cannot be checked for project ${id} before that project is followed elsewhere. ${localRuntimeLine(prepared).en} `
      + `${localRuntimeStep(prepared) ?? ''} Nothing was changed.` };
  }
  if (!projects.includes(id)) return null;
  return { code: 'scope_has_local_data', message: `This computer's own FULI already has project ${id}; following a host `
    + 'for it would hide that project here, and moving a project between computers is a later step '
    + `(docs/runner-roles-design.md §7). It stays on this computer; nothing was changed.\n项目 ${id} 在这台电脑上有自己的数据；`
    + '把它搬到主机是之后的步骤（设计 §7），现在它留在这台电脑，什么都没改。' };
}

// This computer's channel to its host, as `fuli runner sync` opens it.
async function followerConnection(dataDir, store) {
  return createHostConnection({ store, identity: await loadDeviceIdentity(join(dataDir, 'peer')) });
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
