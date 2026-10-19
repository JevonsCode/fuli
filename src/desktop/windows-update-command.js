import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../system/main-module.js';
import { confirmInTerminal, writeLine } from '../cli/terminal-io.js';
import { parseWindowsCommandOptions } from './windows-command-options.js';
import { planWindowsUpdate, updateWindowsInstallation } from './windows-update.js';

export async function runWindowsUpdateCommand(args = [], dependencies = {}) {
  const { options, yes, preview } = parseWindowsCommandOptions(args, dependencies, 'Update');
  options.source = dependencies.source ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const write = dependencies.write ?? writeLine;
  const plan = (dependencies.plan ?? planWindowsUpdate)(options);
  if (plan.downgrade) write('这是降版替换（--allow-downgrade）：程序换成更低的版本号，数据不变；更新前请先备份数据目录。 / This replaces Fuli with a lower version (--allow-downgrade); data is kept. Back up the data folder first.');
  write(`更新 / Update: ${plan.current.applicationVersion} → ${plan.applicationVersion}\n程序 / Application: ${plan.installRoot}\n保留数据 / Keep data: ${plan.current.dataDir}\n请先退出 Fuli 托盘；服务会自动停止后重启。 / Exit the tray first; services will be stopped and restarted.`);
  if (preview) return { status: 'preview' };
  const confirm = dependencies.confirm ?? (() => confirmInTerminal('更新？ / Update? [y/N] ', { defaultYes: false }));
  if (!yes && !await confirm()) return { status: 'cancelled' };
  const result = await (dependencies.update ?? updateWindowsInstallation)({ ...options,
    expectedInstallationId: plan.current.installationId, expectedInventorySha256: plan.inventorySha256 }, { write });
  write('已更新 / Updated: ' + result.applicationVersion + '\n请从桌面或开始菜单重新打开 Fuli。 / Reopen Fuli from Desktop or Start menu.');
  // Clients keep the MCP server they started; only a restart loads this version.
  write('已打开的 Claude Code / Codex 等会话需要重启才会用上新版（更省 Token）。 / Restart open Claude Code, Codex and other client sessions to load the new version (it uses fewer tokens).');
  if (result.clients !== 'reconnected') write('客户端重新连接未完成；请检查后运行新版 setup。 / Client reconnection did not finish; inspect the installation and run setup from the new version.');
  return result;
}

if (isMainModule(import.meta.url)) {
  try { await runWindowsUpdateCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
