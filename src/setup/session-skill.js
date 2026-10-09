import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Windows refuses to rename a directory another process is watching, such as
// a running Codex app. Those targets are refreshed in place after a backup copy.
const LOCKED_DIRECTORY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function installSessionSkill(agent, {
  sourcePath,
  backupDir,
  clock = () => new Date(),
  rename = renameSync
}) {
  if (!agent.skillPath) throw new TypeError(`Missing Skill path for ${agent.label}`);
  const sourceEntry = join(sourcePath, 'SKILL.md');
  if (!existsSync(sourceEntry)) throw new Error('Fuli session Skill source is missing');

  if (isSessionSkillCurrent(sourcePath, agent.skillPath)) {
    return { status: 'current', path: agent.skillPath, backupPath: null };
  }

  mkdirSync(dirname(agent.skillPath), { recursive: true });
  let backupPath = null;
  if (existsSync(agent.skillPath)) {
    const stamp = clock().toISOString().replaceAll(/[:.]/g, '-');
    backupPath = join(backupDir, 'skills', `${agent.id}-${stamp}`, basename(agent.skillPath));
    mkdirSync(dirname(backupPath), { recursive: true });
    try {
      rename(agent.skillPath, backupPath);
    } catch (error) {
      if (!LOCKED_DIRECTORY_CODES.has(error?.code)) throw error;
      cpSync(agent.skillPath, backupPath, { recursive: true, errorOnExist: true });
      replaceDirectoryContents(agent.skillPath, sourcePath);
      return { status: 'installed', path: agent.skillPath, backupPath };
    }
  }

  const stagingPath = `${agent.skillPath}.fuli-installing`;
  rmSync(stagingPath, { recursive: true, force: true });
  try {
    cpSync(sourcePath, stagingPath, { recursive: true, errorOnExist: true });
    renameSync(stagingPath, agent.skillPath);
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    if (backupPath && !existsSync(agent.skillPath)) renameSync(backupPath, agent.skillPath);
    throw error;
  }

  return { status: 'installed', path: agent.skillPath, backupPath };
}

export function isSessionSkillCurrent(sourcePath, targetPath) {
  const sourceEntry = join(sourcePath, 'SKILL.md');
  const targetEntry = join(targetPath, 'SKILL.md');
  if (!existsSync(sourceEntry) || !existsSync(targetEntry)) return false;
  try {
    const sourceFiles = listFiles(sourcePath);
    const targetFiles = listFiles(targetPath);
    if (
      sourceFiles.length !== targetFiles.length ||
      sourceFiles.some((file, index) => file !== targetFiles[index])
    ) {
      return false;
    }
    return sourceFiles.every((file) => (
      readFileSync(join(sourcePath, file)).equals(readFileSync(join(targetPath, file)))
    ));
  } catch {
    return false;
  }
}

export function removeBundledSkill(agent, {
  sourcePath,
  fileExists = existsSync,
  remove = rmSync
}) {
  if (!agent.skillPath || !fileExists(agent.skillPath)) {
    return { status: 'not_installed', path: agent.skillPath ?? null };
  }
  if (!isSessionSkillCurrent(sourcePath, agent.skillPath)) {
    return { status: 'preserved_modified', path: agent.skillPath };
  }
  remove(agent.skillPath, { recursive: true, force: false });
  return { status: 'removed', path: agent.skillPath };
}

function replaceDirectoryContents(targetPath, sourcePath) {
  const sourceFiles = new Set(listFiles(sourcePath));
  for (const file of listFiles(targetPath)) {
    if (!sourceFiles.has(file)) rmSync(join(targetPath, file), { force: true });
  }
  cpSync(sourcePath, targetPath, { recursive: true, force: true });
}

function listFiles(root, directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
    })
    .sort();
}
