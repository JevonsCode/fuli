import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

export function openDatabase(filePath) {
  if (isFileDatabase(filePath)) {
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
  }
  return new Database(filePath);
}

export function isFileDatabase(filePath) {
  return typeof filePath === 'string' && filePath !== ':memory:' && filePath !== '';
}
