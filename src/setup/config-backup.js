import {
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
  copyFile = copyFileSync
}) {
  const sources = [
    { path: agent.configPath, suffix: '' },
    ...(agent.settingsPath
      ? [{ path: agent.settingsPath, suffix: '-settings' }]
      : [])
  ].filter(({ path }) => path && fileExists(path));
  if (sources.length === 0) return null;
  makeDirectory(backupDir, { recursive: true });
  const timestamp = now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const backups = sources.map(({ path, suffix }) => {
    const extension = extname(path) || '.bak';
    const backupPath = join(
      backupDir,
      `${agent.id}${suffix}-${timestamp}${extension}`
    );
    copyFile(path, backupPath);
    return { path, backupPath };
  });
  return (
    backups.find(({ path }) => path === agent.configPath)
    ?? backups[0]
  ).backupPath;
}
