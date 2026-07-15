import { validateLegacyRecords } from './legacy-record-validation.js';

const REQUIRED_COLLECTIONS = ['spaces', 'subscriptions', 'episodes', 'facts', 'candidates'];
const OPTIONAL_COLLECTIONS = ['outbox', 'imports'];

export function validateLegacySnapshot(snapshot) {
  if (!isRecord(snapshot)) throw new TypeError('Snapshot must be a JSON object');
  const collections = requireCollections(snapshot);
  validateLegacyRecords(collections);
  return collections;
}

function requireCollections(snapshot) {
  const collections = {};
  for (const name of REQUIRED_COLLECTIONS) collections[name] = requireArray(snapshot, name);
  for (const name of OPTIONAL_COLLECTIONS) {
    if (Object.hasOwn(snapshot, name)) collections[name] = requireArray(snapshot, name);
  }
  return collections;
}

function requireArray(snapshot, name) {
  if (!Array.isArray(snapshot[name])) throw new TypeError(`Snapshot ${name} must be an array`);
  return snapshot[name].map((record, index) => {
    if (!isRecord(record)) throw new TypeError(`Snapshot ${name}[${index}] must be an object`);
    return record;
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
