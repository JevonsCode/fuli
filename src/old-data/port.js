import { ApplicationError } from '../app/application-error.js';
import { allocatedDirectorySize } from '../system/resource-monitor.js';
import { listBackupFiles, readBackupFile } from './backup-reader.js';
import { oldDataInventory, publicOldDataItem } from './inventory.js';

// 旧数据 for one data directory (rec#80 group B): the list with how much the
// live data and the old data take, and a read-only look into one item. The
// console and the person's own AI (read_old_data) read the same port; restore
// and delete-now are the console's (console-actions.js).
//
// The whole data directory is measured as the resource monitor measures it
// and kept for a minute, so opening the list again does not rescan every
// file; a delete or restore forgets the measurement.
const DATA_SIZE_CACHE_MS = 60_000;

export function createOldDataShelf({ paths, now = () => Date.now(), measure = allocatedDirectorySize }) {
  let measured = null;

  async function dataBytes() {
    if (measured && now() - measured.at < DATA_SIZE_CACHE_MS) return measured;
    const at = now();
    measured = { at, bytes: await measure(paths.dataDir) };
    return measured;
  }

  async function find(id) {
    const item = (await oldDataInventory(paths)).find((candidate) => candidate.id === id);
    if (!item) throw new ApplicationError('old_data_not_found', `No old data is listed as ${id}`, { status: 404 });
    return item;
  }

  return {
    dataDir: paths.dataDir,
    // items newest first; summary: live data (the data directory without the
    // old data, which all lies inside it), old data, and both together.
    async list() {
      const [items, data] = await Promise.all([oldDataInventory(paths), dataBytes()]);
      const oldBytes = items.reduce((sum, item) => sum + item.bytes, 0);
      const totalBytes = Math.max(data.bytes, oldBytes);
      return { items: items.map(publicOldDataItem),
        summary: { liveBytes: totalBytes - oldBytes, oldBytes, totalBytes, measuredAt: new Date(data.at).toISOString() } };
    },
    // Without path: the item and its files. With path: one listed text file, bounded.
    async read({ id, path = null }) {
      const item = await find(id);
      return path === null ? { item: publicOldDataItem(item), ...listBackupFiles(item) } : readBackupFile(item, path);
    },
    find,
    forgetMeasurement() {
      measured = null;
    }
  };
}
