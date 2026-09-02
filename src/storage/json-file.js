import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_IO = Object.freeze({ mkdirSync, renameSync, rmSync, statSync, writeFileSync });

export function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;

  const raw = readFileSync(filePath, 'utf8');
  return raw.trim() ? JSON.parse(raw) : fallback;
}

export function writeJsonFileAtomic(filePath, value, io = {}) {
  const fileIo = { ...DEFAULT_IO, ...io };
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let mode = 0o600;
  try {
    mode = fileIo.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  fileIo.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fileIo.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode
    });
    fileIo.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fileIo.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the write or rename failure that caused cleanup.
    }
    throw error;
  }
}
