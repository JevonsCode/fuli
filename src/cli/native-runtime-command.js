import { createInterface } from 'node:readline/promises';
import { manageNativeNeo4j, planNativeNeo4j } from '../native-runtime/neo4j-lifecycle.js';
import { releaseStaleNeo4jLifecycleLock } from '../native-runtime/neo4j-lifecycle-lock.js';
import { lockReleaseRefusal } from '../local-runtime/startup-failure.js';
import { applyNativeRecovery, planNativeRecovery } from '../native-runtime/neo4j-recovery.js';
import { createNativeGraphServices, NATIVE_NEO4J_VERSION } from '../native-runtime/runtime.js';
import { runGraphDataCommand } from './graph-data-command.js';
import { formatRecoveryPlan } from './recovery-plan-text.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { runSetupCommand } from './setup-command.js';
import { writeLine } from './terminal-io.js';

export function parseNativeRuntimeOptions(args = []) {
  const [action, ...flags] = args;
  if (!['install', 'update', 'rollback', 'uninstall', 'unlock', 'recover'].includes(action)) throw new Error('graph runtime requires install, update, rollback, uninstall, unlock or recover.');
  const result = { action, preview: false, yes: false, dataDir: null, expect: null, backOut: false, json: false }, seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    if (flag === '--preview') result.preview = true;
    else if (flag === '--yes') result.yes = true;
    else if (flag === '--data-dir' && flags[i + 1]?.trim() && !flags[i + 1].startsWith('--')) result.dataDir = flags[++i];
    else if (action === 'recover' && flag === '--expect' && /^[0-9a-f]{16}$/.test(flags[i + 1] ?? '')) result.expect = flags[++i];
    else if (action === 'recover' && flag === '--back-out') result.backOut = true;
    else if (action === 'recover' && flag === '--json') result.json = true;
    else throw new Error(`Invalid graph runtime option: ${flag}`);
  }
  return result;
}

export async function runNativeRuntimeCommand(args, dependencies = {}) {
  const options = parseNativeRuntimeOptions(args), env = dependencies.env ?? process.env;
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('graph runtime asset management currently requires macOS.');
  const paths = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options.dataDir, env });
  const write = dependencies.write ?? writeLine;
  if (options.action === 'unlock') return unlock(paths, options, write, dependencies);
  if (options.action === 'recover') return recover(paths, options, write, { ...dependencies, env });
  const plan = options.action === 'install' ? { neo4jVersion: NATIVE_NEO4J_VERSION }
    : await (dependencies.plan ?? planNativeNeo4j)({ paths, action: options.action });
  write(`Native Neo4j ${options.action}: ${plan.neo4jVersion ?? NATIVE_NEO4J_VERSION}\nData: ${paths.dataDir}\nKnowledge data is preserved. Java is not installed or upgraded.`);
  if (plan.upgrade) write(`Neo4j ${plan.current.neo4jVersion} → ${plan.neo4jVersion}: the graph is backed up under ${paths.graphBackupDir} first; rolling back to ${plan.current.neo4jVersion} afterwards is refused.`);
  if (options.preview) return { status: 'preview', action: options.action, neo4jVersion: plan.neo4jVersion };
  if (!options.yes && !await (dependencies.confirm ?? confirmAction)(options.action)) return { status: 'cancelled' };
  const result = options.action === 'install'
    ? await (dependencies.setup ?? runSetupCommand)(['--yes', '--skip-agents', '--runtime-mode', 'native', '--data-dir', paths.dataDir], { env, write })
    : await (dependencies.manage ?? manageNativeNeo4j)({ paths, action: options.action, env });
  write(`Native Neo4j: ${result.status}.`);
  return result;
}
async function confirmAction(action) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return ['y', 'yes'].includes((await input.question(`${action} native Neo4j assets now? [y/N] `)).trim().toLowerCase()); }
  finally { input.close(); }
}

// Releases a lifecycle lock no start takes over by itself, after the checks in
// releaseStaleNeo4jLifecycleLock; the desktop window offers the same through its controller.
async function unlock(paths, options, write, dependencies) {
  write(`Release the native Neo4j lifecycle lock of ${paths.dataDir} once nothing uses it.`);
  if (options.preview) return { status: 'preview', action: 'unlock' };
  if (!options.yes && !await (dependencies.confirm ?? confirmAction)('Release the lock of')) return { status: 'cancelled' };
  const result = await (dependencies.releaseLock ?? releaseStaleNeo4jLifecycleLock)({ paths });
  if (result.released) {
    write('已解除这把锁，可以启动 FULI 了。 / The lock is released; FULI can start now.');
    return { status: 'released', exitCode: 0 };
  }
  // Why it kept the lock, in words and as the reason line a desktop client reads (startup-failure-line.js).
  throw Object.assign(new Error(lockReleaseRefusal(result)), { startupFailure: { code: 'lock_kept', ...result } });
}

// Brings the runtime back from an operation killed part way (neo4j-recovery.js):
// shows the plan, and does it only when confirmed, or with --yes --expect <the
// plan's digest> as the desktop controller sends after the person confirmed.
// For the person only: no Agent tool reaches it (operating-fuli).
async function recover(paths, options, write, dependencies) {
  const recovery = {
    stopServices: (_paths, owner) => createNativeGraphServices({ paths,
      env: { ...dependencies.env, FULI_NATIVE_ASSET_OPERATION: owner } }).stopDatabases(),
    restore: from => (dependencies.importGraph ?? runGraphDataCommand)('import', ['--input', from, '--yes', '--data-dir', paths.dataDir],
      { env: dependencies.env, write }),
    ...dependencies.recovery
  };
  const plan = await (dependencies.planRecovery ?? planNativeRecovery)({ paths, backOut: options.backOut, dependencies: recovery });
  if (options.json && options.preview) {
    write(JSON.stringify(plan));
    return { status: 'preview', exitCode: 0 };
  }
  write(formatRecoveryPlan(plan));
  if (plan.kind === 'nothing') return { status: 'nothing', exitCode: 0 };
  if (plan.kind === 'refused') throw Object.assign(new Error(formatRecoveryPlan(plan)), { startupFailure: { code: 'recovery_refused', ...plan } });
  if (options.preview) return { status: 'preview', exitCode: 0 };
  if (options.yes ? options.expect !== plan.digest : !await (dependencies.confirm ?? confirmAction)('Recover')) {
    if (options.yes) throw Object.assign(new Error(formatRecoveryPlan({ kind: 'refused', reason: 'plan_changed' })),
      { startupFailure: { code: 'recovery_refused', reason: 'plan_changed' } });
    return { status: 'cancelled', exitCode: 1 };
  }
  const result = await (dependencies.applyRecovery ?? applyNativeRecovery)({ paths, digest: plan.digest, backOut: options.backOut, dependencies: recovery });
  if (result.kind === 'refused') throw Object.assign(new Error(formatRecoveryPlan(result)), { startupFailure: { code: 'recovery_refused', ...result } });
  write('已恢复，可以启动 FULI 了。 / Recovered; FULI can start now.');
  return { status: 'recovered', kind: result.kind, exitCode: 0 };
}
