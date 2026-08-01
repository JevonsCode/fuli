import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

const CURRENT_VERSION = 2;
const EMPTY_REGISTRY = Object.freeze({ version: CURRENT_VERSION, bindings: [] });

export class ExternalKnowledgeRegistry {
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('External knowledge registry path is required');
    }
    this.filePath = filePath;
  }

  list() {
    return clone(this.#read().bindings);
  }

  get(id) {
    const binding = this.#read().bindings.find((item) => item.id === id);
    return binding ? clone(binding) : null;
  }

  put(binding) {
    const document = this.#read();
    const index = document.bindings.findIndex((item) => item.id === binding.id);
    if (index === -1) document.bindings.push(clone(binding));
    else document.bindings[index] = clone(binding);
    writeJsonFileAtomic(this.filePath, document);
    return clone(binding);
  }

  delete(id) {
    const document = this.#read();
    const next = document.bindings.filter((item) => item.id !== id);
    if (next.length === document.bindings.length) return false;
    writeJsonFileAtomic(this.filePath, { ...document, bindings: next });
    return true;
  }

  #read() {
    const document = readJsonFile(this.filePath, EMPTY_REGISTRY);
    if (!Array.isArray(document?.bindings)) {
      throw new TypeError('Unsupported external knowledge registry format');
    }
    if (document.version === CURRENT_VERSION) return clone(document);
    if (document.version === 1) return migrateVersionOne(document);
    throw new TypeError('Unsupported external knowledge registry format');
  }
}

function migrateVersionOne(document) {
  return {
    version: CURRENT_VERSION,
    bindings: document.bindings.map((binding) => {
      if (!binding?.target || typeof binding.target !== 'object') {
        throw new TypeError('Legacy external knowledge binding target is invalid');
      }
      const {
        target,
        mode = 'hybrid',
        sync = emptySyncState(),
        ...source
      } = binding;
      return {
        ...source,
        targets: [{
          id: binding.id,
          personalSpaceId: target.personalSpaceId,
          personalProjectId: target.personalProjectId,
          mode,
          status: binding.status ?? 'ready',
          sync
        }]
      };
    })
  };
}

function emptySyncState() {
  return {
    cursor: null,
    lastSyncedAt: null,
    error: null,
    skippedCredentials: 0,
    items: {}
  };
}

function clone(value) {
  return structuredClone(value);
}
