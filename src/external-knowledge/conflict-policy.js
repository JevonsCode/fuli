import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

const MODES = new Set(['ask_human', 'agent_decide']);
const EMPTY_POLICIES = Object.freeze({ version: 1, projects: {} });

export class KnowledgeConflictPolicyStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('Knowledge conflict policy path is required');
    }
    this.filePath = filePath;
    this.now = now;
  }

  get(personalProjectId) {
    const id = requiredString(personalProjectId, 'personalProjectId');
    const projects = this.#read().projects;
    const stored = projects[policyKey(id)] ??
      (Object.hasOwn(projects, id) ? projects[id] : null);
    return stored
      ? structuredClone(stored)
      : { personalProjectId: id, mode: 'ask_human', updatedAt: null };
  }

  set(personalProjectId, mode) {
    const id = requiredString(personalProjectId, 'personalProjectId');
    if (!MODES.has(mode)) {
      throw new TypeError('Conflict policy mode must be ask_human or agent_decide');
    }
    const document = this.#read();
    const policy = {
      personalProjectId: id,
      mode,
      updatedAt: this.now().toISOString()
    };
    document.projects[policyKey(id)] = policy;
    writeJsonFileAtomic(this.filePath, document);
    return structuredClone(policy);
  }

  #read() {
    const document = readJsonFile(this.filePath, EMPTY_POLICIES);
    if (document?.version !== 1 || !document.projects ||
        typeof document.projects !== 'object' || Array.isArray(document.projects)) {
      throw new TypeError('Unsupported knowledge conflict policy format');
    }
    return structuredClone(document);
  }
}

function policyKey(personalProjectId) {
  return `project:${personalProjectId}`;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}
