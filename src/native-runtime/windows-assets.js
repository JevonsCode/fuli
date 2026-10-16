import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export function readWindowsNativeBundle(packageRoot) {
  const path = join(packageRoot, 'native-bundle.json');
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.version !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64'
      || manifest.providerPackaging !== 'embedded') {
    throw new Error('The Windows portable bundle manifest is not supported.');
  }
  const root = realpathSync(packageRoot);
  const paths = Object.fromEntries(['neo4jHome', 'javaHome', 'providerPython', 'providerSource', 'dataDir']
    .map(key => {
      const value = manifest[key];
      if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) {
        throw new Error('Portable bundle paths must be relative: ' + key);
      }
      const resolved = resolve(root, value);
      const local = relative(root, resolved);
      if (!local || local.startsWith('..') || isAbsolute(local)) {
        throw new Error('Portable bundle paths must stay inside the bundle: ' + key);
      }
      return [key, resolved];
    }));
  return { ...paths, bundleRoot: root, providerPackaging: 'embedded', assetSource: 'portable' };
}

// This accepts supplied assets; downloading and installer defaults are separate.
// An external Python (including a venv) is not a verified portable Provider.
export function resolveWindowsNativeBundle(bundle, { providerSource } = {}) {
  const required = ['neo4jHome', 'javaHome', 'providerPython'];
  if (!bundle || required.some(key => typeof bundle[key] !== 'string' || !bundle[key].trim())) {
    throw new Error('Windows native mode requires an explicit Neo4j, Java 21 and Provider Python bundle descriptor.');
  }
  const assets = Object.fromEntries(required.map(key => [key, realpathSync(resolve(bundle[key]))]));
  for (const path of [join(assets.javaHome, 'bin', 'java.exe'), join(assets.javaHome, 'lib', 'modules'),
    join(assets.neo4jHome, 'conf', 'neo4j.conf'), assets.providerPython]) {
    if (!existsSync(path)) throw new Error('A supplied Windows native asset is missing: ' + path);
  }
  const javaVersion = /^JAVA_VERSION="([^"]+)"/m.exec(readFileSync(join(assets.javaHome, 'release'), 'utf8'))?.[1];
  if (!/^21(?:\.|$)/.test(javaVersion ?? '')) throw new Error('Windows native mode requires Java 21 assets.');
  const versions = readdirSync(join(assets.neo4jHome, 'lib'))
    .map(name => /^neo4j-kernel-(5\.26\.\d+)\.jar$/.exec(name)?.[1]).filter(Boolean);
  if (versions.length !== 1 || !existsSync(join(assets.neo4jHome, 'lib', 'neo4j-' + versions[0] + '.jar'))) {
    throw new Error('The supplied Windows Neo4j assets must contain one complete Community 5.26 runtime.');
  }
  const source = realpathSync(resolve(bundle.providerSource ?? providerSource));
  const embedded = bundle.providerPackaging === 'embedded';
  if (embedded) {
    const pythonHome = resolve(assets.providerPython, '..');
    const pth = join(pythonHome, 'python312._pth');
    if (!bundle.bundleRoot || !existsSync(pth) || !existsSync(join(pythonHome, 'python312.zip'))
        || existsSync(join(pythonHome, 'pyvenv.cfg')) || !existsSync(join(source, 'fuli_graph', 'app.py'))) {
      throw new Error('The portable Provider requires an isolated embedded Python and vendored application.');
    }
    for (const path of [...Object.values(assets), source]) {
      const local = relative(realpathSync(bundle.bundleRoot), path);
      if (local.startsWith('..') || isAbsolute(local)) throw new Error('Portable assets must stay inside the bundle.');
    }
    const entries = readFileSync(pth, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (entries.some(line => !['python312.zip', '.', 'Lib/site-packages', 'import site'].includes(line))
        || !entries.includes('Lib/site-packages')) {
      throw new Error('The portable Python search path must contain only bundled dependencies.');
    }
  }
  return { ...assets, platform: 'win32', neo4jVersion: versions[0], javaVersion,
    providerSource: source,
    providerPackaging: embedded ? 'embedded' : 'external', assetSource: embedded ? 'portable' : 'provided' };
}
