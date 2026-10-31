import { isMainModule } from '../system/main-module.js';
import { confirmInTerminal, writeLine } from '../cli/terminal-io.js';
import { parseWindowsCommandOptions } from './windows-command-options.js';
import { planWindowsUninstall, uninstallWindowsInstallation } from './windows-uninstall.js';

export async function runWindowsUninstallCommand(args = [], dependencies = {}) {
  const { options, yes, preview } = parseWindowsCommandOptions(args, dependencies, 'Uninstall');
  const write = dependencies.write ?? writeLine;
  const plan = (dependencies.plan ?? planWindowsUninstall)(options);
  write(`卸载 / Uninstall: Fuli ${plan.current.applicationVersion}（${plan.slots.length} 个版本 / versions）\n程序 / Application: ${plan.installRoot}\n保留数据 / Keep data: ${plan.current.dataDir}\n将关闭 FULI 桌面客户端、停止服务、断开 Agent 客户端，并删除快捷方式和开机启动项；数据目录不会改动。 / The FULI desktop client closes, services stop, Agent clients are disconnected, and shortcuts and the launch-at-login entry are removed; the data folder is not changed.`);
  if (preview) return { status: 'preview' };
  const confirm = dependencies.confirm ?? (() => confirmInTerminal('卸载？ / Uninstall? [y/N] ', { defaultYes: false }));
  if (!yes && !await confirm()) return { status: 'cancelled' };
  const result = await (dependencies.uninstall ?? uninstallWindowsInstallation)({ ...options,
    expectedInstallationId: plan.current.installationId }, { write });
  write('已卸载 / Uninstalled. 数据保留在 / Data kept at: ' + result.dataDir);
  if (result.status === 'removing_after_exit') write('程序文件将在此窗口关闭后几秒内删除。 / Program files are removed a few seconds after this window closes.');
  if (result.registrations === 'failed') write('开机启动项、fuli:// 链接或桌面客户端设置没有删除；请在 Windows 设置的「启动应用」里检查 FULI。 / The launch-at-login entry, the fuli:// link handler or desktop client settings were not removed; check FULI under Startup apps in Windows Settings.');
  for (const path of result.keptShortcuts) write('已保留被修改的快捷方式 / Kept a changed shortcut: ' + path);
  if (result.leftover) write('程序目录中还有其他文件，已保留 / Other files remain in: ' + result.leftover);
  write('重启已打开的 Claude Code / Codex 会话以卸下 Fuli。 / Restart open client sessions to unload Fuli.');
  return result;
}

if (isMainModule(import.meta.url)) {
  try { await runWindowsUninstallCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
