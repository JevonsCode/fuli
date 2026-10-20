import { MODEL_BACKEND_ROLES } from '../model-backends/config.js';
import { openModelBackendRuntime } from '../model-backends/runtime.js';
import { createModelSecretStore, secretReference } from '../model-backends/secret-store.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readHiddenLine, writeLine } from './terminal-io.js';

// fuli models: local key entry and a synthetic connection check for the
// optional model backends of the built-in Agents. Keys are read without echo
// and never printed; configuration stays in model-backends.json.

const USAGE = 'Usage: fuli models set-key <secretRef> [--data-dir DIR] | fuli models check <role> [--data-dir DIR]';

export async function runModelsCommand(args, {
  env = process.env,
  readSecret = readHiddenLine,
  openSecretStore = path => createModelSecretStore({ path }),
  openPort = openModelBackendRuntime,
  write = writeLine
} = {}) {
  const { action, subject, dataDir } = parseModelsArguments(args);
  const paths = resolveSetupPaths({ dataDir, env });
  if (action === 'set-key') {
    const secret = await readSecret({ prompt: `API key for ${subject} (input hidden): ` });
    await openSecretStore(paths.modelSecretStorePath).set(subject, secret);
    write(`Saved the key for ${subject} on this computer only (${process.platform === 'win32'
      ? 'encrypted for the current Windows user' : 'readable by the current user only'}).`);
    return { exitCode: 0 };
  }
  const port = openPort(paths);
  try {
    const { modelReceipt } = await port.checkConnection(subject);
    write(JSON.stringify(modelReceipt));
    return { exitCode: modelReceipt.status === 'completed' ? 0 : 1 };
  } finally {
    port.close();
  }
}

function parseModelsArguments(args) {
  const [action, subject, ...options] = args;
  if (!['set-key', 'check'].includes(action) || !subject || subject.startsWith('--')) throw new TypeError(USAGE);
  if (action === 'set-key') secretReference(subject, 'secretRef');
  if (action === 'check' && !MODEL_BACKEND_ROLES.includes(subject)) {
    throw new TypeError(`Unknown role: ${subject}. Use one of ${MODEL_BACKEND_ROLES.join(', ')}`);
  }
  let dataDir = null;
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] !== '--data-dir' || dataDir !== null) throw new TypeError(USAGE);
    const value = options[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError('Missing value for --data-dir');
    dataDir = value;
    index += 1;
  }
  return { action, subject, dataDir };
}
