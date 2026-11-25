import { createHash } from 'node:crypto';
import { immediateTransaction } from '../../packages/roundtable/src/storage/database-format.js';
import { SCOPE_ENVELOPE_MAX_BYTES } from './protocol.js';
import { digestValue, moveError, moveKey } from './move-store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
// The authenticated request lane carries a 32 KiB JSON body including base64.
export const MOVE_CHUNK = 18 * 1024;
const where = ' WHERE space=? AND project=? AND move_id=? AND kind=?';
const kinds = ['graph','board','baseline'];
export function movePackages(store, move) {
  const db = store.db;
  function key(kind) {
    if (!kinds.includes(kind)) throw moveError('move_file_invalid');
    return [...moveKey(move), kind];
  }
  const manifest = kind => db.prepare('SELECT digest,bytes FROM move_files' + where).get(...key(kind));
  function declare(kind, info) {
    if (!digestValue(info?.digest) || !Number.isSafeInteger(info.bytes) || info.bytes < 1 || info.bytes > SCOPE_ENVELOPE_MAX_BYTES) {
      throw moveError('move_file_invalid');
    }
    db.prepare('INSERT OR IGNORE INTO move_files VALUES(?,?,?,?,?,?)').run(...key(kind), info.digest, info.bytes);
    const row = manifest(kind);
    if (row.digest !== info.digest || row.bytes !== info.bytes) throw moveError('move_file_changed');
  }
  function put(kind, position, data) {
    const info = manifest(kind);
    if (!info || !Number.isSafeInteger(position) || position < 0 || position >= info.bytes || position % MOVE_CHUNK ||
      !Buffer.isBuffer(data) || data.length !== Math.min(MOVE_CHUNK, info.bytes - position)) throw moveError('move_chunk_invalid');
    const prior = db.prepare('SELECT data FROM move_chunks' + where + ' AND position=?').get(...key(kind), position);
    if (prior) {
      if (!Buffer.from(prior.data).equals(data)) throw moveError('move_file_changed');
    } else db.prepare('INSERT INTO move_chunks VALUES(?,?,?,?,?,?)').run(...key(kind), position, data);
  }
  function chunk(kind, position) {
    const row = db.prepare('SELECT data FROM move_chunks' + where + ' AND position=?').get(...key(kind), position);
    if (!row) throw moveError('move_chunk_missing');
    return Buffer.from(row.data);
  }
  function read(kind) {
    const info = manifest(kind);
    if (!info || info.bytes < 1 || info.bytes > SCOPE_ENVELOPE_MAX_BYTES) throw moveError('move_file_invalid');
    const result = Buffer.alloc(info.bytes);
    for (let position = 0; position < info.bytes; position += MOVE_CHUNK) {
      const data = chunk(kind, position);
      if (data.length !== Math.min(MOVE_CHUNK, info.bytes - position)) throw moveError('move_file_changed');
      data.copy(result, position);
    }
    if (hash(result) !== info.digest) throw moveError('move_file_changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(result);
  }
  function save(kind, text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > SCOPE_ENVELOPE_MAX_BYTES) throw moveError('move_file_invalid');
    const data = Buffer.from(text);
    const info = { bytes: data.length, digest: hash(data) };
    immediateTransaction(db, () => {
      declare(kind, info);
      for (let position = 0; position < data.length; position += MOVE_CHUNK) put(kind, position, data.subarray(position, position + MOVE_CHUNK));
    });
    return info;
  }
  return { manifest, declare, put, chunk, read, save };
}
