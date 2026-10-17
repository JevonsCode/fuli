import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { isMainModule } from '../system/main-module.js';
import { windowsMigrationCommand } from './windows-installation-context.js';
import { installWindowsForCurrentUser, planFirstWindowsInstall } from './windows-installation.js';

export function windowsInstallPreview(plan) {
  const data = plan.adoptedData
    ? '\n数据 / Data (existing, adopted unchanged): ' + plan.dataDir
      + '\n当前图运行方式 / Current graph runtime: ' + plan.adoptedData.runtimeMode
    : '\n数据 / Data (created on first start): ' + plan.dataDir;
  return '首次安装 / First installation\n程序 / Application: ' + plan.installRoot + data
    + '\n快捷方式 / Shortcuts:\n' + plan.shortcuts.join('\n')
    + '\n不启动服务、不启用开机启动、不修改已有数据。 / No service start, startup registration or data change.\n';
}

export function windowsInstalledMessage(result, adoptedData) {
  const lines = ['安装完成 / Installed: ' + result.packageRoot];
  if (adoptedData?.runtimeMode === 'container') {
    lines.push('已有数据仍使用 Docker 容器。迁移到内置数据库（核对计数，失败自动切回）：',
      'The existing data still uses Docker containers. Move it to the built-in database (count-verified, switches back on failure):',
      windowsMigrationCommand(result.packageRoot));
  } else {
    lines.push('请从桌面或开始菜单打开 Fuli。 / Open Fuli from Desktop or Start menu.');
  }
  return lines.join('\n') + '\n';
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Install on Windows x64.');
    const options = { source: resolve(dirname(fileURLToPath(import.meta.url)), '../..') };
    const names = { '--install-root': 'installRoot', '--data-dir': 'dataDir', '--desktop-dir': 'desktop', '--start-menu-dir': 'startMenu' };
    let yes = false;
    for (let index = 2; index < process.argv.length; index++) {
      if (process.argv[index] === '--yes') { yes = true; continue; }
      if (process.argv[index] === '--adopt-existing-data') { options.adoptExistingData = true; continue; }
      const key = names[process.argv[index]];
      if (!key || !process.argv[index + 1]) throw new Error('Unknown or missing installation option.');
      const value = process.argv[++index];
      if (['desktop', 'startMenu'].includes(key)) (options.shortcutDirectories ??= {})[key] = value;
      else options[key] = value;
    }
    const plan = planFirstWindowsInstall(options);
    process.stdout.write(windowsInstallPreview(plan));
    if (!yes) {
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { if ((await input.question('安装？ / Install? [y/N] ')).trim().toLowerCase() !== 'y') process.exit(0); }
      finally { input.close(); }
    }
    const result = installWindowsForCurrentUser(options);
    process.stdout.write(windowsInstalledMessage(result, plan.adoptedData));
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
