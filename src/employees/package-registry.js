import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EmployeeError, parseEmployeeManifest } from './manifest.js';

const builtinRoot = fileURLToPath(new URL('./catalog/', import.meta.url));

export function createEmployeePackageRegistry({ packageDirectory, dataDirectory, catalogDirectory = builtinRoot }) {
  const runtimes = new Map();
  let closed = false;

  function catalog() {
    const entries = new Map();
    for (const file of readdirSync(catalogDirectory).filter((name) => name.endsWith('.json'))) {
      const manifest = readManifest(join(catalogDirectory, file));
      entries.set(manifest.id, { manifest, root: null, runtimeStatus: manifest.runtime ? 'install_required' : 'not_required' });
    }
    if (packageDirectory && existsSync(packageDirectory)) {
      for (const name of readdirSync(packageDirectory)) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) continue;
        const root = join(packageDirectory, name);
        try {
          if (!statSync(root).isDirectory()) continue;
          confinedPath(packageDirectory, name);
          const manifest = readManifest(confinedPath(root, 'employee.json'));
          if (manifest.id !== name) continue;
          if (manifest.runtime) {
            confinedPath(root, manifest.runtime.entry);
            confinedPath(root, `${manifest.runtime.webRoot}/index.html`);
          }
          entries.set(name, { manifest, root, runtimeStatus: manifest.runtime ? 'ready' : 'not_required' });
        } catch {
          const previous = entries.get(name);
          if (previous) entries.set(name, { ...previous, runtimeStatus: 'unavailable' });
        }
      }
    }
    return [...entries.values()];
  }

  function get(id) {
    const entry = catalog().find(({ manifest }) => manifest.id === id);
    if (!entry) throw new EmployeeError('Employee template not found', 404, 'template_not_found');
    return entry;
  }

  async function runtime(id) {
    if (closed) throw new EmployeeError('Employee runtime is closed', 503, 'runtime_closed');
    const entry = get(id);
    if (entry.runtimeStatus !== 'ready' || !entry.manifest.runtime) {
      throw new EmployeeError('Employee workbench package is not installed or unavailable', 503, 'runtime_unavailable');
    }
    if (!runtimes.has(id)) {
      const loading = (async () => {
        const module = await import(pathToFileURL(confinedPath(entry.root, entry.manifest.runtime.entry)).href);
        if (typeof module.createEmployeeRuntime !== 'function') throw new TypeError('Invalid employee runtime export');
        const instance = await module.createEmployeeRuntime({
          dataDirectory: resolve(dataDirectory, id),
          packageDirectory: entry.root,
          manifest: entry.manifest
        });
        if (!instance || !['handleHttp', 'callTool', 'describeTools', 'close'].every(
          (name) => typeof instance[name] === 'function'
        )) {
          instance?.close?.();
          throw new TypeError('Employee runtime does not implement API version 1');
        }
        if (closed) { await instance.close(); throw new Error('Employee runtime is closed'); }
        return instance;
      })().catch(() => {
        runtimes.delete(id);
        throw new EmployeeError('Employee runtime could not be loaded', 503, 'runtime_unavailable');
      });
      runtimes.set(id, loading);
    }
    return runtimes.get(id);
  }

  return {
    catalog, get, runtime,
    async close() {
      closed = true;
      await Promise.allSettled([...runtimes.values()].map(async (entry) => (await entry).close()));
      runtimes.clear();
    }
  };
}

export function confinedPath(root, file) {
  const resolvedRoot = realpathSync(root);
  const resolvedFile = realpathSync(resolve(root, file));
  const local = relative(resolvedRoot, resolvedFile);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new TypeError('Employee package path escapes its installation');
  }
  return resolvedFile;
}

function readManifest(file) {
  if (statSync(file).size > 32_768) throw new TypeError('Employee manifest is too large');
  return parseEmployeeManifest(JSON.parse(readFileSync(file, 'utf8')));
}

export function employeeDirectories(runtimeConfigPath) {
  const root = join(dirname(runtimeConfigPath), 'employees');
  return { packageDirectory: join(root, 'packages'), dataDirectory: join(root, 'data') };
}
