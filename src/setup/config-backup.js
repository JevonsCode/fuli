import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync
} from 'node:fs';
import { extname, join } from 'node:path';

export function backupAgentConfig(agent, {
  backupDir,
  now = () => new Date(),
  fileExists = existsSync,
  makeDirectory = mkdirSync,
  copyFile = copyFileSync,
  setMode = chmodSync
}) {
  const sources = [
    { path: agent.configPath, suffix: '' },
    ...(agent.settingsPath
      ? [{ path: agent.settingsPath, suffix: '-settings' }]
      : []),
    ...(agent.hooksPath
      ? [{ path: agent.hooksPath, suffix: '-hooks' }]
      : []),
    ...(agent.globalInstructionsPath
      ? [{ path: agent.globalInstructionsPath, suffix: '-instructions' }]
      : []),
    ...(agent.globalInstructionsOverridePath
      ? [{
          path: agent.globalInstructionsOverridePath,
          suffix: '-instructions-override'
        }]
      : [])
  ].filter(({ path }) => path && fileExists(path));
  if (sources.length === 0) return null;
  makeDirectory(backupDir, { recursive: true, mode: 0o700 });
  setMode(backupDir, 0o700);
  const timestamp = now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backups = sources.map(({ path, suffix }) => {
    const extension = extname(path) || '.bak';
    const backupPath = join(
      backupDir,
      `${agent.id}${suffix}-${timestamp}${extension}`
    );
    copyFile(path, backupPath);
    setMode(backupPath, 0o600);
    return { path, backupPath };
  });
  return (
    backups.find(({ path }) => path === agent.configPath)
    ?? backups[0]
  ).backupPath;
}
