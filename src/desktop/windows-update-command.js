import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../system/main-module.js';
import { confirmInTerminal, writeLine } from '../cli/terminal-io.js';
import { planWindowsUpdate, updateWindowsInstallation } from './windows-update.js';

export async function runWindowsUpdateCommand(args = [], dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'win32' || (dependencies.arch ?? process.arch) !== 'x64') {
    throw new Error('Update on Windows x64.');
  }
  const options = { source: dependencies.source ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'), env: dependencies.env ?? process.env };
  let yes = false, preview = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error('Duplicate update option: ' + arg);
    seen.add(arg);
    if (arg === '--yes') yes = true;
    else if (arg === '--preview') preview = true;
    else if (arg === '--install-root' && args[index + 1] && !args[index + 1].startsWith('--')) options.installRoot = args[++index];
    else throw new Error('Unknown or missing update option: ' + arg);
  }
  const write = dependencies.write ?? writeLine;
  const plan = (dependencies.plan ?? planWindowsUpdate)(options);
  write(`更新 / Update: ${plan.current.applicationVersion} → ${plan.applicationVersion}\n程序 / Application: ${plan.installRoot}\n保留数据 / Keep data: ${plan.current.dataDir}\n请先退出 Fuli 托盘；服务会自动停止后重启。 / Exit the tray first; services will be stopped and restarted.`);
  if (preview) return { status: 'preview' };
  const confirm = dependencies.confirm ?? (() => confirmInTerminal('更新？ / Update? [y/N] ', { defaultYes: false }));
  if (!yes && !await confirm()) return { status: 'cancelled' };
  const result = await (dependencies.update ?? updateWindowsInstallation)({ ...options,
    expectedInstallationId: plan.current.installationId, expectedInventorySha256: plan.inventorySha256 }, { write });
  write('已更新 / Updated: ' + result.applicationVersion + '\n请从桌面或开始菜单重新打开 Fuli。 / Reopen Fuli from Desktop or Start menu.');
  if (result.clients !== 'reconnected') write('客户端重新连接未完成；请检查后运行新版 setup。 / Client reconnection did not finish; inspect the installation and run setup from the new version.');
  return result;
}

if (isMainModule(import.meta.url)) {
  try { await runWindowsUpdateCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
