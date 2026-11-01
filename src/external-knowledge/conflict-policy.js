import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { requiredString } from '../validation/values.js';

const MODES = new Set(['ask_human', 'agent_decide']);
const BUILT_IN_DEFAULT = Object.freeze({ mode: 'ask_human', updatedAt: null });
const EMPTY_POLICIES = Object.freeze({ version: 1, projects: {} });
// Version 1 gained an optional `default` ({ mode, updatedAt }) beside
// `projects`. An older FULI ignores it (unset projects ask the human) and
// keeps it when it rewrites the file, so no migration is needed.
export const CONFLICT_POLICY_FORMAT = jsonFormat({ store: 'external-knowledge-conflicts', versions: [1] });

export class KnowledgeConflictPolicyStore {
  constructor(filePath, { now = () => new Date() } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('Knowledge conflict policy path is required');
    }
    this.filePath = filePath;
    this.now = now;
  }

  // The policy that applies to one project: its own choice, else the default.
  get(personalProjectId) {
    const id = requiredString(personalProjectId, 'personalProjectId');
    const document = this.#read();
    const own = projectPolicy(document.projects, id);
    if (own) return { ...structuredClone(own), source: 'project' };
    const fallback = defaultPolicy(document);
    return { personalProjectId: id, mode: fallback.mode, updatedAt: fallback.updatedAt, source: 'default' };
  }

  // The default and only the projects that chose differently from it.
  overview() {
    const document = this.#read();
    const projects = new Map();
    for (const [key, policy] of Object.entries(document.projects)) {
      const id = policy?.personalProjectId;
      if (typeof id !== 'string' || !MODES.has(policy.mode)) continue;
      // A prefixed key wins over a legacy unprefixed one for the same project.
      if (!projects.has(id) || key === policyKey(id)) projects.set(id, structuredClone(policy));
    }
    return {
      default: defaultPolicy(document),
      projects: [...projects.values()].sort((left, right) =>
        left.personalProjectId.localeCompare(right.personalProjectId))
    };
  }

  set(personalProjectId, mode) {
    const id = requiredString(personalProjectId, 'personalProjectId');
    requireMode(mode);
    const document = this.#read();
    const policy = { personalProjectId: id, mode, updatedAt: this.now().toISOString() };
    document.projects[policyKey(id)] = policy;
    this.#write(document);
    return { ...structuredClone(policy), source: 'project' };
  }

  // Removes a project's own choice so the default applies to it again.
  clear(personalProjectId) {
    const id = requiredString(personalProjectId, 'personalProjectId');
    const document = this.#read();
    const keys = [policyKey(id), id].filter((key) => Object.hasOwn(document.projects, key));
    if (keys.length) {
      for (const key of keys) delete document.projects[key];
      this.#write(document);
    }
    return this.get(id);
  }

  setDefault(mode) {
    requireMode(mode);
    const document = this.#read();
    document.default = { mode, updatedAt: this.now().toISOString() };
    this.#write(document);
    return structuredClone(document.default);
  }

  #read() {
    const document = readJsonFile(this.filePath, EMPTY_POLICIES);
    if (document?.version !== 1 || !document.projects ||
        typeof document.projects !== 'object' || Array.isArray(document.projects)) {
      throw new TypeError('Unsupported knowledge conflict policy format');
    }
    return structuredClone(document);
  }

  #write(document) {
    writeVersionedJsonFileAtomic(this.filePath, document, CONFLICT_POLICY_FORMAT);
  }
}

function requireMode(mode) {
  if (!MODES.has(mode)) {
    throw new TypeError('Conflict policy mode must be ask_human or agent_decide');
  }
}

function projectPolicy(projects, id) {
  return projects[policyKey(id)] ?? (Object.hasOwn(projects, id) ? projects[id] : null);
}

function defaultPolicy(document) {
  const stored = document.default;
  return MODES.has(stored?.mode)
    ? { mode: stored.mode, updatedAt: stored.updatedAt ?? null }
    : { ...BUILT_IN_DEFAULT };
}

function policyKey(personalProjectId) {
  return `project:${personalProjectId}`;
}
