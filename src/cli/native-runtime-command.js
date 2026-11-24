import { createInterface } from 'node:readline/promises';
import { manageNativeNeo4j, planNativeNeo4j } from '../native-runtime/neo4j-lifecycle.js';
import { releaseStaleNeo4jLifecycleLock } from '../native-runtime/neo4j-lifecycle-lock.js';
import { lockReleaseRefusal } from '../local-runtime/startup-failure.js';
import { applyNativeRecovery, planNativeRecovery } from '../native-runtime/neo4j-recovery.js';
import { nativeRecoveryServices } from '../native-runtime/recovery-services.js';
import { NATIVE_NEO4J_VERSION } from '../native-runtime/runtime.js';
import { formatRecoveryPlan, recoveredLine } from './recovery-plan-text.js';
import { ownsLocalProjects } from '../runner/owned-project-routes.js';
import { followsHost, refuseOnFollower } from './follower-graph-refusal.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { runSetupCommand } from './setup-command.js';
import { writeLine } from './terminal-io.js';

export function parseNativeRuntimeOptions(args = []) {
  const [action, ...flags] = args;
  if (!['status', 'start', 'stop', 'install', 'update', 'rollback', 'uninstall', 'unlock', 'recover'].includes(action)) throw new Error('graph runtime requires status, start, stop, install, update, rollback, uninstall, unlock or recover.');
  const result = { action, preview: false, yes: false, dataDir: null, expect: null, backOut: false, abandonImport: false, keepNewer: false, json: false }, seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    if (flag === '--preview') result.preview = true;
    else if (flag === '--yes') result.yes = true;
    else if (flag === '--data-dir' && flags[i + 1]?.trim() && !flags[i + 1].startsWith('--')) result.dataDir = flags[++i];
    else if (action === 'recover' && flag === '--expect' && /^[0-9a-f]{16}$/.test(flags[i + 1] ?? '')) result.expect = flags[++i];
    else if (action === 'recover' && flag === '--back-out') result.backOut = true;
    else if (action === 'recover' && flag === '--abandon-import') result.abandonImport = true;
    else if (action === 'recover' && flag === '--keep-newer') result.keepNewer = true;
    else if (action === 'recover' && flag === '--json') result.json = true;
    else throw new Error(`Invalid graph runtime option: ${flag}`);
  }
  if ([result.backOut, result.abandonImport, result.keepNewer].filter(Boolean).length > 1) {
    throw new Error('--back-out, --abandon-import and --keep-newer are different recoveries; choose one.');
  }
  return result;
}

export async function runNativeRuntimeCommand(args, dependencies = {}) {
  const options = parseNativeRuntimeOptions(args), env = dependencies.env ?? process.env;
  const paths = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options.dataDir, env });
  const write = dependencies.write ?? writeLine;
  if (['status', 'start', 'stop'].includes(options.action)) {
    refuseOnFollower(paths.dataDir, `fuli graph runtime ${options.action}`, { isRunner: dependencies.isRunner });
    if (!followsHost(paths.dataDir, { isRunner: dependencies.isRunner }) || !ownsLocalProjects(paths.dataDir)) {
      throw new Error('Use the normal FULI runtime controls on this computer.');
    }
    const { runLocalRuntimeCommand } = await import('./local-runtime-command.js');
    return runLocalRuntimeCommand(options.action, ['--data-dir', paths.dataDir], dependencies);
  }
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('graph runtime asset management currently requires macOS.');
  // Releasing a lock no holder is recorded for, and looking at a recovery plan, start nothing.
  if (options.action !== 'unlock' && !(options.action === 'recover' && options.preview)) {
    refuseOnFollower(paths.dataDir, `fuli graph runtime ${options.action}`,
      { isRunner: dependencies.isRunner, recover: options.action === 'recover' });
  }
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
// shows the plan, and does it only when confirmed in a terminal (the prompt, or
// --yes --expect <the plan's digest>). Abandoning an import (--abandon-import)
// takes typing `abandon` at the prompt; --yes is refused. Keeping the newer
// version of an unfinished switch without a start check (--keep-newer) is its
// own plan, confirmed the same way as any other. Without a terminal
// only the preview runs: an Agent's non-interactive shell cannot recover, and
// no MCP tool reaches it. The desktop window recovers through its controller
// after the person confirmed there.
async function recover(paths, options, write, dependencies) {
  const recovery = { ...nativeRecoveryServices({ paths, env: dependencies.env }), ...dependencies.recovery };
  const choice = { backOut: options.backOut, abandonImport: options.abandonImport, keepNewer: options.keepNewer };
  const plan = await (dependencies.planRecovery ?? planNativeRecovery)({ paths, ...choice, dependencies: recovery });
  if (options.json && options.preview) {
    write(JSON.stringify(plan));
    return { status: 'preview', exitCode: 0 };
  }
  write(formatRecoveryPlan(plan));
  if (plan.kind === 'nothing') return { status: 'nothing', exitCode: 0 };
  if (plan.kind === 'refused') throw refusal(plan);
  if (options.preview) return { status: 'preview', exitCode: 0 };
  if (!(dependencies.interactive ?? process.stdin.isTTY)) throw refusal({ kind: 'refused', reason: 'needs_person' });
  if (options.abandonImport) {
    if (options.yes) throw refusal({ kind: 'refused', reason: 'abandon_needs_typing' });
    if (!await (dependencies.confirmAbandon ?? confirmAbandon)()) return { status: 'cancelled', exitCode: 1 };
  } else if (options.yes ? options.expect !== plan.digest : !await (dependencies.confirm ?? confirmAction)('Recover')) {
    if (options.yes) throw refusal({ kind: 'refused', reason: 'plan_changed' });
    return { status: 'cancelled', exitCode: 1 };
  }
  let result;
  try {
    result = await (dependencies.applyRecovery ?? applyNativeRecovery)({ paths, digest: plan.digest, ...choice, dependencies: recovery });
  } catch (error) {
    if (error?.code !== 'recover_step_failed') throw error;
    throw refusal({ kind: 'refused', ...error.facts, reason: error.reason, step: error.step, record: error.record, planKind: error.planKind }, error);
  }
  if (result.kind === 'refused') throw refusal(result);
  write(recoveredLine(result));
  return { status: 'recovered', kind: result.kind, record: result.record ?? null, ...(result.startFailure ? { startFailure: result.startFailure } : {}), exitCode: 0 };
}

// Giving up an import empties graphs, so it takes the word, not a y.
async function confirmAbandon() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question('输入 abandon 并回车，确认放弃这次导入 / Type abandon and press Enter to abandon the import: ')).trim() === 'abandon'; }
  finally { input.close(); }
}

// Why it will not, in words and as the reason line a desktop client reads (startup-failure-line.js).
function refusal(plan, cause) {
  return Object.assign(new Error(formatRecoveryPlan(plan), cause ? { cause } : undefined),
    { startupFailure: { code: 'recovery_refused', ...plan } });
}
