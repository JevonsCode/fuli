import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const DEFAULT_IO = Object.freeze({ mkdirSync, renameSync, rmSync, writeFileSync });

export function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;

  const raw = readFileSync(filePath, 'utf8');
  return raw.trim() ? JSON.parse(raw) : fallback;
}

export function writeJsonFileAtomic(filePath, value, io = {}) {
  const fileIo = { ...DEFAULT_IO, ...io };
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);

  fileIo.mkdirSync(directory, { recursive: true });
  try {
    fileIo.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
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
