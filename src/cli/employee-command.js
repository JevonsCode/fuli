import { installEmployeePackage } from '../employees/install-package.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';

export async function runEmployeeCommand(args, { env = process.env } = {}) {
  const [action, sourceDirectory, ...options] = args;
  if (action !== 'install' || !sourceDirectory || sourceDirectory.startsWith('--')) {
    throw new TypeError('Usage: fl employee install <built-package-directory> [--replace] [--runtime-config <file>]');
  }
  const runtime = resolveGraphRuntimeOptions(options, env);
  const result = installEmployeePackage({
    sourceDirectory, runtimeConfigPath: runtime.runtimeConfigPath,
    replace: options.includes('--replace')
  });
  console.log(JSON.stringify(result));
  console.log('Open FULI → Agents → Recruit employee. Loaded package updates take effect after the host restarts.');
  return result;
}
