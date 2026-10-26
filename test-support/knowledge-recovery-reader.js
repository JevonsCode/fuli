import { join } from 'node:path';
import { JudgmentStore } from '../src/judgment/store.js';
import { createKnowledgeRecoveryGate } from '../src/knowledge-hard-delete/recovery-gate.js';

// Separate Agent-side process, with only the ordinary aggregate read port.
const [dataDir, space] = process.argv.slice(2);
let next = 0;
const waiting = new Map();
const gate = createKnowledgeRecoveryGate({ dataDir, readWatermark: () => new Promise((resolve, reject) => {
  const watermarkId = ++next;
  waiting.set(watermarkId, { resolve, reject });
  process.send({ watermarkId });
}) });
const store = new JudgmentStore(join(dataDir, 'judgment.sqlite'), { recoveryGate: gate });
process.on('message', async message => {
  if (message.watermarkId) {
    const pending = waiting.get(message.watermarkId); waiting.delete(message.watermarkId);
    if (message.error) pending.reject(new Error('Synthetic provider unavailable'));
    else pending.resolve(message.value);
    return;
  }
  try {
    let value;
    if (message.action === 'refresh') value = await gate.refresh(space, { force: true });
    else if (message.action === 'read') value = store.records(space);
    else if (message.action === 'write') value = store.record(space, { kind: 'review', target: 'entity:other', title: 'Synthetic unrelated' }, message.key);
    else if (message.action === 'close') { store.close(); process.send({ id: message.id, value: true }); process.disconnect(); return; }
    else throw new Error('Unknown synthetic action');
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: { code: error.code, status: error.status, message: error.message } }); }
});
process.send({ ready: true });
