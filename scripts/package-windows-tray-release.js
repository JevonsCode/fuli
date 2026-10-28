import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { trayInventory } from '../src/desktop/windows-installation.js';
import { trayArchiveName, trayChecksumLine } from '../src/desktop/windows-tray-release.js';
import { sha256File } from '../src/security/digest.js';
import { isMainModule } from '../src/system/main-module.js';

// The release asset a per-user Windows installation updates from
// (src/desktop/windows-tray-release.js): a built tray candidate as one zip
// and its SHA-256. The candidate is verified against its own inventory first.
export async function packageWindowsTrayRelease({ tray, output } = {}) {
  if (process.platform !== 'win32') throw new Error('Package the Windows tray on Windows.');
  for (const [name, path] of Object.entries({ tray, output })) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Expected an absolute --' + name + ' path.');
  }
  const { entries } = trayInventory(tray);
  // A release ships the desktop client as its tray app (scripts/build-windows-tray.js).
  if (!entries.some(([name]) => name === 'client/FULI.exe')) throw new Error('The tray candidate has no desktop client (client/FULI.exe).');
  const version = JSON.parse(await readFile(join(tray, 'package.json'), 'utf8')).version;
  const name = trayArchiveName(version);
  const archive = join(output, name);
  await mkdir(output, { recursive: true });
  if (existsSync(archive)) throw new Error('The release archive already exists: ' + archive);
  await new Promise((resolve, reject) => execFile(join(process.env.SystemRoot, 'System32', 'tar.exe'),
    ['-a', '-c', '-f', archive, '-C', tray, '.'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    error => error ? reject(error) : resolve()));
  await writeFile(archive + '.sha256', trayChecksumLine(await sha256File(archive), name));
  return { archive, checksum: archive + '.sha256', version };
}

if (isMainModule(import.meta.url)) {
  const names = { '--tray': 'tray', '--output': 'output' };
  const options = {};
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1] || options[key]) throw new Error('Invalid option: ' + process.argv[index]);
      options[key] = process.argv[index + 1];
    }
    const result = await packageWindowsTrayRelease(options);
    process.stdout.write('Packaged ' + result.archive + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
