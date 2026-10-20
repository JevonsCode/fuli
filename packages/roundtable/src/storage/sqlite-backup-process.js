import { backup, DatabaseSync } from 'node:sqlite';

// Runs SQLite's online backup API for sqlite-format.js, which needs the copy
// finished before it continues: node sqlite-backup-process.js <source> <target>
const [source, target] = process.argv.slice(2);
const database = new DatabaseSync(source, { readOnly: true });
try {
  database.exec('PRAGMA busy_timeout = 5000');
  await backup(database, target);
} finally {
  database.close();
}
