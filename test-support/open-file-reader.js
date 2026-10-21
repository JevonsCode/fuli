import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

// How long the reader keeps the file open once the write has started: long
// enough that the first rename certainly meets it, well inside the writer's
// retry budget.
const HELD_AFTER_WRITE_STARTS_MS = 200;

const READER = `
const { closeSync, openSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const descriptor = openSync(workerData.path, 'r');
parentPort.postMessage('open');
Atomics.wait(workerData.writing, 0, 0);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.heldMs);
closeSync(descriptor);
`;

// Runs write() while another thread holds path open for reading, as a console
// request reading a FULI file would. The reader opens the file first, and
// closes it only after the write has started, so a synchronous write meets
// the open file on its first rename and must wait for the reader to close.
export async function writeWhileReaderHoldsOpen(path, write) {
  const writing = new Int32Array(new SharedArrayBuffer(4));
  const reader = new Worker(READER, { eval: true,
    workerData: { path, writing, heldMs: HELD_AFTER_WRITE_STARTS_MS } });
  // A reader that fails to open reports it through the 'message' wait below.
  const closed = once(reader, 'exit').catch(() => {});
  try {
    await once(reader, 'message');
    Atomics.store(writing, 0, 1);
    Atomics.notify(writing, 0);
    return await write();
  } finally {
    Atomics.store(writing, 0, 1);
    Atomics.notify(writing, 0);
    await closed;
  }
}
