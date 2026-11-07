import { MODEL_BACKEND_ROLES } from '../model-backends/config.js';
import { openModelBackendRuntime } from '../model-backends/runtime.js';
import { createModelSecretStore, keyOrigin, secretReference } from '../model-backends/secret-store.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readHiddenLine, writeLine } from './terminal-io.js';

// fuli models: local key entry and a synthetic connection check for the
// optional model backends of the built-in Agents. Keys are read without echo
// and never printed; configuration stays in model-backends.json. A key is
// tied to the endpoint origin it is for (--endpoint) and is sent nowhere else.

const USAGE = 'Usage: fuli models set-key <secretRef> --endpoint URL [--data-dir DIR] | fuli models check <role> [--data-dir DIR]';

export async function runModelsCommand(args, {
  env = process.env,
  readSecret = readHiddenLine,
  openSecretStore = path => createModelSecretStore({ path }),
  openPort = openModelBackendRuntime,
  write = writeLine
} = {}) {
  const { action, subject, dataDir, endpoint } = parseModelsArguments(args);
  const paths = resolveSetupPaths({ dataDir, env });
  if (action === 'set-key') {
    const secret = await readSecret({ prompt: `API key for ${subject} (input hidden): ` });
    await openSecretStore(paths.modelSecretStorePath).set(subject, secret, endpoint);
    write(`Saved the key for ${subject}, for ${keyOrigin(endpoint)} only, on this computer (${process.platform === 'win32'
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
  const values = { '--data-dir': null, ...(action === 'set-key' ? { '--endpoint': null } : {}) };
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (!Object.hasOwn(values, option) || values[option] !== null) throw new TypeError(USAGE);
    const value = options[index + 1];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${option}`);
    values[option] = value;
    index += 1;
  }
  if (action === 'set-key' && values['--endpoint'] === null) throw new TypeError(`--endpoint is required: the key is sent only there. ${USAGE}`);
  if (action === 'set-key') keyOrigin(values['--endpoint'], '--endpoint');
  return { action, subject, dataDir: values['--data-dir'], endpoint: values['--endpoint'] ?? null };
}
