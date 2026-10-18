import { isMainModule } from '../system/main-module.js';
import { confirmInTerminal, writeLine } from '../cli/terminal-io.js';
import { parseWindowsCommandOptions } from './windows-command-options.js';
import { planWindowsUninstall, uninstallWindowsInstallation } from './windows-uninstall.js';

export async function runWindowsUninstallCommand(args = [], dependencies = {}) {
  const { options, yes, preview } = parseWindowsCommandOptions(args, dependencies, 'Uninstall');
  const write = dependencies.write ?? writeLine;
  const plan = (dependencies.plan ?? planWindowsUninstall)(options);
  write(`卸载 / Uninstall: Fuli ${plan.current.applicationVersion}（${plan.slots.length} 个版本 / versions）\n程序 / Application: ${plan.installRoot}\n保留数据 / Keep data: ${plan.current.dataDir}\n将停止服务、断开 Agent 客户端并删除快捷方式；数据目录不会改动。 / Services stop, Agent clients are disconnected and shortcuts removed; the data folder is not changed.\n请先退出 Fuli 托盘。 / Exit the tray first.`);
  if (preview) return { status: 'preview' };
  const confirm = dependencies.confirm ?? (() => confirmInTerminal('卸载？ / Uninstall? [y/N] ', { defaultYes: false }));
  if (!yes && !await confirm()) return { status: 'cancelled' };
  const result = await (dependencies.uninstall ?? uninstallWindowsInstallation)({ ...options,
    expectedInstallationId: plan.current.installationId }, { write });
  write('已卸载 / Uninstalled. 数据保留在 / Data kept at: ' + result.dataDir);
  if (result.status === 'removing_after_exit') write('程序文件将在此窗口关闭后几秒内删除。 / Program files are removed a few seconds after this window closes.');
  for (const path of result.keptShortcuts) write('已保留被修改的快捷方式 / Kept a changed shortcut: ' + path);
  if (result.leftover) write('程序目录中还有其他文件，已保留 / Other files remain in: ' + result.leftover);
  write('重启已打开的 Claude Code / Codex 会话以卸下 Fuli。 / Restart open client sessions to unload Fuli.');
  return result;
}

if (isMainModule(import.meta.url)) {
  try { await runWindowsUninstallCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
