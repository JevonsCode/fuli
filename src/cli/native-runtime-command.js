import { createInterface } from 'node:readline/promises';
import { manageNativeNeo4j, planNativeNeo4j } from '../native-runtime/neo4j-lifecycle.js';
import { NATIVE_NEO4J_VERSION } from '../native-runtime/runtime.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { runSetupCommand } from './setup-command.js';
import { writeLine } from './terminal-io.js';

export function parseNativeRuntimeOptions(args = []) {
  const [action, ...flags] = args;
  if (!['install', 'update', 'rollback', 'uninstall'].includes(action)) throw new Error('graph runtime requires install, update, rollback or uninstall.');
  const result = { action, preview: false, yes: false, dataDir: null }, seen = new Set();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (seen.has(flag)) throw new Error(`Duplicate ${flag}`);
    seen.add(flag);
    if (flag === '--preview') result.preview = true;
    else if (flag === '--yes') result.yes = true;
    else if (flag === '--data-dir' && flags[i + 1]?.trim() && !flags[i + 1].startsWith('--')) result.dataDir = flags[++i];
    else throw new Error(`Invalid graph runtime option: ${flag}`);
  }
  return result;
}

export async function runNativeRuntimeCommand(args, dependencies = {}) {
  const options = parseNativeRuntimeOptions(args), env = dependencies.env ?? process.env;
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new Error('graph runtime asset management currently requires macOS.');
  const paths = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options.dataDir, env });
  const write = dependencies.write ?? writeLine;
  const plan = options.action === 'install' ? { neo4jVersion: NATIVE_NEO4J_VERSION }
    : await (dependencies.plan ?? planNativeNeo4j)({ paths, action: options.action });
  write(`Native Neo4j ${options.action}: ${plan.neo4jVersion ?? NATIVE_NEO4J_VERSION}\nData: ${paths.dataDir}\nKnowledge data is preserved. Java is not installed or upgraded.`);
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
