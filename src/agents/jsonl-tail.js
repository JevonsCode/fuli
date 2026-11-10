import { open } from 'node:fs/promises';

// A client's own JSONL transcript as FULI reads it for a recent answer: its
// first record (the client's session header) and the records in the last
// `bytes` of the file. A cut line is not a record, and a line that is not
// JSON is skipped.
const HEADER_BYTES = 64 * 1024;

export async function readJsonlTail(path, bytes) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, bytes);
    const text = await read(file, length, size - length);
    const head = await read(file, Math.min(size, HEADER_BYTES), 0);
    const end = head.indexOf('\n');
    const first = end >= 0 || size <= HEADER_BYTES ? parse(end >= 0 ? head.slice(0, end) : head)[0] ?? null : null;
    return { first, records: parse(size > length ? text.slice(text.indexOf('\n') + 1) : text) };
  } finally {
    await file.close();
  }
}

async function read(file, length, position) {
  const buffer = Buffer.alloc(length);
  await file.read(buffer, 0, length, position);
  return buffer.toString('utf8');
}

function parse(text) {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
