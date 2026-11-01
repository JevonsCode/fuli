import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trayInventory } from '../src/desktop/windows-installation.js';
import { trayChecksumLine } from '../src/desktop/windows-tray-release.js';
import { sha256File } from '../src/security/digest.js';
import { isMainModule } from '../src/system/main-module.js';

// FULI-Setup-<version>.exe, the one-file Windows install a release attaches
// next to the tray zip: desktop/windows-setup/fuli-setup.iss compiled by Inno
// Setup's ISCC.exe over a verified tray directory, and its SHA-256.

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SETUP_SCRIPT = join(PACKAGE_ROOT, 'desktop', 'windows-setup', 'fuli-setup.iss');
const DEFAULT_ISCC = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';
const ISCC_TIMEOUT_MS = 60 * 60_000;

export const setupFileName = version => `FULI-Setup-${version}.exe`;

// The tray files the setup script names (#define Tray... "<path>"), as tray-relative paths.
export function setupTrayFiles(script) {
  return [...script.matchAll(/^#define\s+Tray\w+\s+"([^"]+)"\s*$/gm)].map(match => match[1].replaceAll('\\', '/'));
}

// ISCC's arguments: the version is always the tray's own package.json version.
export async function setupCompileArguments({ tray, output, script = SETUP_SCRIPT }) {
  const version = JSON.parse(await readFile(join(tray, 'package.json'), 'utf8')).version;
  const name = setupFileName(version);
  return { version, name, args: ['/Q', `/DAppVersion=${version}`, `/DTrayDir=${tray}`, `/DOutputDir=${output}`,
    `/DOutputBaseFilename=${name.replace(/\.exe$/, '')}`, script] };
}

export async function buildWindowsSetup({ tray, output, iscc = DEFAULT_ISCC } = {}) {
  if (process.platform !== 'win32') throw new Error('Build the Windows setup on Windows.');
  for (const [name, path] of Object.entries({ tray, output, iscc })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute --' + name + ' path.');
  }
  if (!existsSync(iscc)) throw new Error('Inno Setup 6 (ISCC.exe) is required: ' + iscc);
  const { entries } = trayInventory(tray);
  const names = new Set(entries.map(([name]) => name.toLowerCase()));
  for (const file of setupTrayFiles(await readFile(SETUP_SCRIPT, 'utf8'))) {
    if (!names.has(file.toLowerCase())) throw new Error('The tray directory has no ' + file + ' for the setup.');
  }
  const { version, name, args } = await setupCompileArguments({ tray, output });
  const setup = join(output, name);
  await mkdir(output, { recursive: true });
  if (existsSync(setup)) throw new Error('The setup already exists: ' + setup);
  await new Promise((resolveRun, reject) => execFile(iscc, args, { windowsHide: true, timeout: ISCC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout, stderr) => error ? reject(new Error('ISCC failed: ' + (stderr || stdout).slice(-4000))) : resolveRun()));
  await writeFile(setup + '.sha256', trayChecksumLine(await sha256File(setup), name));
  return { setup, checksum: setup + '.sha256', version };
}

if (isMainModule(import.meta.url)) {
  const names = { '--tray': 'tray', '--output': 'output', '--iscc': 'iscc' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    const result = await buildWindowsSetup(options);
    process.stdout.write('Built ' + result.setup + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
