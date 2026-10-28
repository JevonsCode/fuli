import { isMainModule } from '../system/main-module.js';
import { confirmInTerminal, writeLine } from '../cli/terminal-io.js';
import { parseWindowsCommandOptions } from './windows-command-options.js';
import { planWindowsRollback, rollbackWindowsInstallation } from './windows-rollback.js';
import { LOGIN_LAUNCH_NOT_UPDATED } from './windows-update-command.js';

export async function runWindowsRollbackCommand(args = [], dependencies = {}) {
  const { options, yes, preview } = parseWindowsCommandOptions(args, dependencies, 'Rollback');
  const write = dependencies.write ?? writeLine;
  const plan = (dependencies.plan ?? planWindowsRollback)(options);
  write(`回退 / Roll back: ${plan.current.applicationVersion} → ${plan.applicationVersion}\n程序 / Application: ${plan.installRoot}\n保留数据 / Keep data: ${plan.current.dataDir}\n只切换程序，不回退数据或数据库；新版写入的内容保持原样。 / Only the program changes; data and the database are not rolled back.\n正在运行的 FULI 桌面客户端会先关闭；服务会自动停止后重启。 / A running FULI desktop client closes first; services are stopped and restarted.`);
  if (preview) return { status: 'preview' };
  const confirm = dependencies.confirm ?? (() => confirmInTerminal('回退？ / Roll back? [y/N] ', { defaultYes: false }));
  if (!yes && !await confirm()) return { status: 'cancelled' };
  const result = await (dependencies.rollback ?? rollbackWindowsInstallation)({ ...options,
    expectedInstallationId: plan.current.installationId }, { write });
  write('已回退 / Rolled back: ' + result.applicationVersion + '\n请重启已打开的 Claude Code / Codex 会话。 / Restart open client sessions.');
  write(result.desktopClient === 'reopened' ? 'FULI 桌面客户端已重新打开。 / The FULI desktop client is open again.'
    : '可从桌面或开始菜单打开 FULI。 / Open FULI from the Desktop or Start menu.');
  if (result.loginLaunch === 'failed') write(LOGIN_LAUNCH_NOT_UPDATED);
  if (result.clients !== 'reconnected') write('客户端重新连接未完成；请检查后运行 setup。 / Client reconnection did not finish; inspect the installation and run setup.');
  return result;
}

if (isMainModule(import.meta.url)) {
  try { await runWindowsRollbackCommand(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
