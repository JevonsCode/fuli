import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationError } from '../app/application-error.js';

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

  async withMutation(operation) {
    // An OS-backed SQLite reservation coordinates separate console/MCP processes.
    // No credentials or binding data is stored here; a crashed owner releases its lock.
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const path = `${this.filePath}.mutation-lock.sqlite`;
    const lock = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      try { lock.exec('BEGIN IMMEDIATE'); }
      catch (error) {
        if (error.errcode === 5 || error.errcode === 6) {
          throw new ApplicationError('external_knowledge_busy', 'Another external-knowledge mutation is in progress; re-read state before retrying');
        }
        throw error;
      }
      try { return await operation(); }
      finally { lock.exec('ROLLBACK'); }
    } finally { lock.close(); }
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
