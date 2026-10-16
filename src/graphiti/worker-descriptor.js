// The host supplies this contract; no model input or inherited parent identity.
export const WORKER_DESCRIPTOR_ENV = 'FULI_WORKER_DESCRIPTOR';
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const WORKER_TOOLS = new Set([
  'begin_task_context', 'get_collaboration_preferences', 'verify_task_checkpoint',
  'checkpoint_task_knowledge', 'search_current_project_knowledge',
  'get_project_agent_memory', 'list_agent_conversations', 'read_agent_conversation'
]);
const TEXT_LIMITS = { runId: 128, personalProjectId: 128, capability: 128,
  projectPath: 4096, taskPrompt: 8192 };
const FIELDS = new Set([...Object.keys(TEXT_LIMITS), 'toolNames']);

export function decodeWorkerDescriptor(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new TypeError('Worker descriptor is required');
  if (Buffer.byteLength(raw, 'utf8') > MAX_DESCRIPTOR_BYTES) throw new TypeError('Worker descriptor size exceeds its limit');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new TypeError('Worker descriptor JSON is invalid'); }
  return validateWorkerDescriptor(value);
}

export function validateWorkerDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== FIELDS.size ||
      Reflect.ownKeys(value).some(key => !FIELDS.has(key))) {
    throw new TypeError('Worker descriptor must contain only supported host fields');
  }
  for (const [name, maximum] of Object.entries(TEXT_LIMITS)) {
    const text = value[name];
    if (typeof text !== 'string' || !text.trim() || text.length > maximum ||
        (name === 'capability' && text.length < 32)) {
      throw new TypeError(`Worker ${name} is required and must be bounded`);
    }
  }
  const tools = Array.isArray(value.toolNames) ? [...new Set(value.toolNames)] : null;
  if (!tools || tools.length > WORKER_TOOLS.size || tools.some(name => !WORKER_TOOLS.has(name))) {
    throw new TypeError('Worker toolNames must be an explicit supported tool allowlist');
  }
  return { ...value, toolNames: tools };
}
