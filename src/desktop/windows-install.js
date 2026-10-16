import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { isMainModule } from '../system/main-module.js';
import { installWindowsForCurrentUser, planFirstWindowsInstall } from './windows-installation.js';

if (isMainModule(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Install on Windows x64.');
    const options = { source: resolve(dirname(fileURLToPath(import.meta.url)), '../..') };
    const names = { '--install-root': 'installRoot', '--data-dir': 'dataDir', '--desktop-dir': 'desktop', '--start-menu-dir': 'startMenu' };
    let yes = false;
    for (let index = 2; index < process.argv.length; index++) {
      if (process.argv[index] === '--yes') { yes = true; continue; }
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1]) throw new Error('Unknown or missing installation option.');
      const value = process.argv[++index];
      if (['desktop', 'startMenu'].includes(key)) (options.shortcutDirectories ??= {})[key] = value;
      else options[key] = value;
    }
    const plan = planFirstWindowsInstall(options);
    process.stdout.write('首次安装 / First installation\n程序 / Application: ' + plan.installRoot
      + '\n数据 / Data (created on first start): ' + plan.dataDir + '\n快捷方式 / Shortcuts:\n' + plan.shortcuts.join('\n')
      + '\n不启动服务、不启用开机启动、不迁移已有数据。 / No service start, startup registration or existing data migration.\n');
    if (!yes) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { if ((await input.question('安装？ / Install? [y/N] ')).trim().toLowerCase() !== 'y') process.exit(0); }
      finally { input.close(); }
    }
    const result = installWindowsForCurrentUser(options);
    process.stdout.write('安装完成 / Installed: ' + result.packageRoot + '\n请从桌面或开始菜单打开 Fuli。 / Open Fuli from Desktop or Start menu.\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
