import { readJsonFile } from '../storage/json-file.js';
import { refusePendingJsonMigration, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { newerFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationError } from '../app/application-error.js';

const CURRENT_VERSION = 2;
const EMPTY_REGISTRY = Object.freeze({ version: CURRENT_VERSION, bindings: [] });
const STORE = 'external-knowledge';
// A version 1 registry still reads, converted in memory; writing it would
// restructure every binding, which waits for a person (rec#17 D-09).
const BINDING_TARGETS = Object.freeze({ id: 'external-knowledge/2-binding-targets', from: 1, to: 2,
  summary: 'each binding’s single project target becomes a list of targets' });

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
    const document = this.#writable();
    const index = document.bindings.findIndex((item) => item.id === binding.id);
    if (index === -1) document.bindings.push(clone(binding));
    else document.bindings[index] = clone(binding);
    writeVersionedJsonFileAtomic(this.filePath, document, { store: STORE });
    return clone(binding);
  }

  delete(id) {
    const document = this.#writable();
    const next = document.bindings.filter((item) => item.id !== id);
    if (next.length === document.bindings.length) return false;
    writeVersionedJsonFileAtomic(this.filePath, { ...document, bindings: next }, { store: STORE });
    return true;
  }

  #read() {
    const document = this.#stored();
    return document.version === 1 ? migrateVersionOne(document) : clone(document);
  }

  #writable() {
    const document = this.#stored();
    if (document.version === 1) {
      refusePendingJsonMigration(this.filePath, { store: STORE, migration: BINDING_TARGETS,
        detail: `${document.bindings.length} bindings were written by an earlier FULI` });
    }
    return clone(document);
  }

  #stored() {
    const document = readJsonFile(this.filePath, EMPTY_REGISTRY);
    if (Number.isInteger(document?.version) && document.version > CURRENT_VERSION) {
      throw newerFormatError(STORE, document.version, CURRENT_VERSION);
    }
    if (!Array.isArray(document?.bindings) || ![1, CURRENT_VERSION].includes(document.version)) {
      throw new TypeError('Unsupported external knowledge registry format');
    }
    return document;
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
