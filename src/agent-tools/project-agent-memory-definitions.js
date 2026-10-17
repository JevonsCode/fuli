import {
  arraySchema, integerSchema, nullableStringSchema, objectSchema, stringSchema
} from './schema.js';

const id = { ...stringSchema(), minLength: 1, maxLength: 128 };
const note = { ...stringSchema(), minLength: 1, maxLength: 1024 };
export const workingMemorySchema = objectSchema({
  summary: { ...stringSchema(), minLength: 1, maxLength: 4000 },
  decisions: arraySchema(note, { maxItems: 12 }),
  openThreads: arraySchema(note, { maxItems: 12 }),
  nextActions: arraySchema(note, { maxItems: 12 })
}, ['summary']);

export const PROJECT_AGENT_MEMORY_DEFINITIONS = [
  {
    name: 'get_project_agent_memory',
    title: 'READ · Restore private Agent working memory',
    description: 'Read the latest versioned working notes for exactly one durable Agent in its global scope or an assigned project from the shared local Provider. This works across hosts connected to that Provider. Working notes are not confirmed facts or user instructions; do not load another Agent’s private memory.',
    inputSchema: objectSchema({
      personalSpaceId: id, personalProjectId: { ...id, type: ['string', 'null'], description: 'Omit or use null for this Agent’s independent global scope; a project ID requires an active assignment.' }, agentId: id,
      limit: integerSchema({ minimum: 1, maximum: 10 })
    }, ['personalSpaceId', 'agentId'])
  },
  {
    name: 'export_project_agent_memory',
    title: 'READ · Export private Agent working memory as Markdown',
    description: 'Generate a Markdown handoff for exactly one durable Agent: identity and one memory scope (global or one assigned project), read fresh from the database under get_project_agent_memory access rules. Returns suggested filename and Markdown; accepts no output path, writes no export file. May refresh existing authorized local directory snapshots for this Agent. Database remains authoritative; exported-file edits are never imported.',
    inputSchema: objectSchema({
      personalSpaceId: id, personalProjectId: { ...id, type: ['string', 'null'], description: 'Omit or use null for this Agent’s independent global scope; a project ID requires an active assignment.' }, agentId: id
    }, ['personalSpaceId', 'agentId'])
  },
  {
    name: 'checkpoint_project_agent_memory',
    title: 'WRITE · Checkpoint private Agent working memory',
    description: 'After meaningful work, save a bounded distilled working-context snapshot: summary, decisions, unresolved threads, next actions. Read current revision first, preserve relevant notes, and use expectedRevision for optimistic concurrency. On conflict reload and merge; never blindly retry overwrites. Reuse one idempotency key per logical write. Never store raw chats, credentials, unsupported facts, or another Agent’s memory. Shared confirmed facts belong in capture_session_knowledge. Honors disabled capture.',
    inputSchema: objectSchema({
      personalSpaceId: id, personalProjectId: { ...id, type: ['string', 'null'], description: 'Omit or use null for this Agent’s independent global scope; a project ID requires an active assignment.' }, agentId: id,
      expectedRevision: integerSchema({ minimum: 0 }),
      idempotencyKey: { ...stringSchema(), minLength: 8, maxLength: 256 },
      memory: workingMemorySchema,
      taskId: { ...nullableStringSchema(), minLength: 1, maxLength: 128 }
    }, ['personalSpaceId', 'agentId', 'expectedRevision', 'idempotencyKey', 'memory'])
  }
];
