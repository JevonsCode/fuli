import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, refusePendingJsonMigration, updateVersionedJsonFileAtomic } from '../storage/json-format.js';
import { newerFormatError } from '../../packages/roundtable/src/storage/data-format-error.js';
import { acquireFileLock } from '../storage/file-lock.js';
import { ApplicationError } from '../app/application-error.js';

const CURRENT_VERSION = 2;
const EMPTY_REGISTRY = Object.freeze({ version: CURRENT_VERSION, bindings: [] });
// A version 1 registry still reads, converted in memory; writing it would
// restructure every binding, which waits for a person (rec#17 D-09).
const BINDING_TARGETS_MIGRATION = Object.freeze({ id: 'external-knowledge/2-binding-targets', from: 1, to: 2,
  summary: 'each binding’s single project target becomes a list of targets',
  rewrite: (document) => migrateVersionOne(document), recordIds: (document) => document.bindings.map((binding) => binding.id) });
export const EXTERNAL_KNOWLEDGE_FORMAT = jsonFormat({ store: 'external-knowledge', versions: [1, CURRENT_VERSION],
  pendingFrom: 1, migration: BINDING_TARGETS_MIGRATION });

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
    // Coordinates separate console/MCP processes; a crashed owner releases it.
    let release;
    try {
      release = acquireFileLock(`${this.filePath}.mutation-lock.sqlite`);
    } catch (error) {
      if (error.code === 'file_lock_busy') {
        throw new ApplicationError('external_knowledge_busy', 'Another external-knowledge mutation is in progress; re-read state before retrying');
      }
      throw error;
    }
    try { return await operation(); }
    finally { release(); }
  }

  get(id) {
    const binding = this.#read().bindings.find((item) => item.id === id);
    return binding ? clone(binding) : null;
  }

  put(binding) {
    this.#mutate((document) => {
      const index = document.bindings.findIndex((item) => item.id === binding.id);
      if (index === -1) document.bindings.push(clone(binding));
      else document.bindings[index] = clone(binding);
      return document;
    });
    return clone(binding);
  }

  delete(id) {
    let removed = false;
    this.#mutate((document) => {
      const next = document.bindings.filter((item) => item.id !== id);
      removed = next.length !== document.bindings.length;
      return removed ? { ...document, bindings: next } : undefined;
    });
    return removed;
  }

  // The read, the pending check and the write under one hold of the format
  // lock, so a confirmed migration or undo by another process cannot land
  // between them. A version 1 registry is refused, recorded once in its
  // ledger after the lock is released.
  #mutate(change) {
    let pending = null;
    updateVersionedJsonFileAtomic(this.filePath, EXTERNAL_KNOWLEDGE_FORMAT, (current) => {
      const document = validated(current ?? EMPTY_REGISTRY);
      if (document.version === 1) {
        pending = `${document.bindings.length} bindings were written by an earlier FULI`;
        return undefined;
      }
      return change(clone(document));
    });
    if (pending) refusePendingJsonMigration(this.filePath, { format: EXTERNAL_KNOWLEDGE_FORMAT, detail: pending });
  }

  #read() {
    const document = this.#stored();
    return document.version === 1 ? migrateVersionOne(document) : clone(document);
  }

  #stored() {
    return validated(readJsonFile(this.filePath, EMPTY_REGISTRY));
  }
}

function validated(document) {
  if (Number.isInteger(document?.version) && document.version > CURRENT_VERSION) {
    throw newerFormatError(EXTERNAL_KNOWLEDGE_FORMAT.store, document.version, CURRENT_VERSION);
  }
  if (!Array.isArray(document?.bindings) || ![1, CURRENT_VERSION].includes(document.version)) {
    throw new TypeError('Unsupported external knowledge registry format');
  }
  return document;
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
