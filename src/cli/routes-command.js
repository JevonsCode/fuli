import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ApplicationError } from '../app/application-error.js';
import { callScope, describeRoutes, openRoutes } from '../runner/call-routes.js';
import { hostOwner, LOCAL_OWNER, scopeName } from '../runner/routes-store.js';
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
    local SCOPE                   own that scope on this computer again
    scope-of PATH                 which scope a call in that folder belongs to
  SCOPE is \`global\`, \`default\`, or \`project:<id>\`; a project's id is what
  \`fuli routes scope-of PATH\` prints for a folder in it.
  Every action takes --data-dir DIR.`;
// Owning a scope here means answering its calls from this computer's own FULI,
// which a computer that follows a host does not have yet (step 3 of the design).
const NO_LOCAL_FULI = 'This computer has no FULI of its own yet, so it cannot own a scope: it would have nowhere to '
  + 'answer that scope\'s calls from. Taking a scope back is the next step of docs/runner-roles-design.md. '
  + '`fuli routes follow` and `fuli routes list` work now.';

export async function runRoutesCommand(args, { env = process.env, write = writeLine } = {}) {
  const [action, ...rest] = args;
  const dataDir = option(rest, '--data-dir');
  const paths = resolveSetupPaths({ dataDir, env });
  if (!action || action === '--help' || action === '-h') return void write(USAGE);
  if (action === 'scope-of') {
    const folder = named(rest);
    if (!folder) throw new TypeError(`Missing PATH\n${USAGE}`);
    write(callScope(folder));
    return { exitCode: 0 };
  }
  const routes = openRoutes(paths.dataDir);
  const runner = new RunnerStore(join(paths.dataDir, RUNNER_FILE));
  try {
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
      routes.set(scope, hostOwner(host.fingerprint));
      write(`${scope} → ${host.name}. Calls in that scope now read and write there.`);
      return { exitCode: 0 };
    }
    if (action === 'local') {
      if (!existsSync(join(paths.dataDir, 'graph-runtime.json'))) {
        throw new ApplicationError('no_local_fuli', NO_LOCAL_FULI);
      }
      routes.set(scope, LOCAL_OWNER);
      write(`${scope} → this computer.`);
      return { exitCode: 0 };
    }
    throw new TypeError(`Unknown routes action: ${action}\n${USAGE}`);
  } finally {
    runner.close();
    routes.close();
  }
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
