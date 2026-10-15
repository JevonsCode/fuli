import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  return { ...assets, platform: 'win32', neo4jVersion: versions[0], javaVersion,
    providerSource: realpathSync(resolve(bundle.providerSource ?? providerSource)),
    providerPackaging: 'external', assetSource: 'provided' };
}
