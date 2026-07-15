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
  if (!fileExists(agent.configPath)) return null;
  makeDirectory(backupDir, { recursive: true });
  const timestamp = now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const extension = extname(agent.configPath) || '.bak';
  const backupPath = join(backupDir, `${agent.id}-${timestamp}${extension}`);
  copyFile(agent.configPath, backupPath);
  return backupPath;
}
