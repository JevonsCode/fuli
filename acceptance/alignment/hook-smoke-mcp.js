#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpServer } from '../../src/mcp/create-mcp-server.js';
import { TaskContextRegistry } from '../../src/mcp/task-context-registry.js';

const registry = new TaskContextRegistry();
const app = {
  getAgentAccessPolicy: () => ({ enabled: true, updatedAt: null }),
  async beginTaskContext({ sessionId }) {
    const task = registry.begin({
      sessionId,
      personalProjectId: 'hotel-b'
    });
    return {
      taskContextToken: task.token,
      task_context_token: task.token,
      checkpoint_required: true,
      previous_checkpoint_missing: task.previousCheckpointMissing,
      context: {
        personal_space_id: 'synthetic-personal',
        personal_project_id: 'hotel-b'
      },
      effective_preferences: [],
      deferred_conflicts: [],
      task_guidance: {
        retrieval: 'Call search_current_project_knowledge.',
        checkpoint: 'Call checkpoint_task_knowledge with this taskContextToken.'
      }
    };
  },
  async checkpointTaskKnowledge({
    taskContextToken,
    disposition,
    reason,
    capture = null
  }) {
    if (capture || disposition !== 'retain_nothing') {
      throw new TypeError('Synthetic hook smoke accepts retain_nothing only');
    }
    const task = registry.context(taskContextToken);
    registry.checkpoint(taskContextToken, {
      disposition,
      reason,
      captureStatus: null
    });
    return {
      status: 'checkpointed',
      disposition,
      personal_project_id: task.personalProjectId
    };
  },
  verifyTaskCheckpoint({ sessionId }) {
    return registry.verify(sessionId);
  },
  async searchCurrentProjectKnowledge({ queries }) {
    return {
      status: 'searched',
      personal_space_id: 'synthetic-personal',
      personal_project_id: 'hotel-b',
      project_resolution: {
        status: 'matched',
        basis: 'synthetic_hook_smoke',
        personal_project_id: 'hotel-b'
      },
      scope_policy: {
        local_project_first: true,
        inherited_relation_types: ['PART_OF', 'USES_KNOWLEDGE_FROM'],
        max_inheritance_hops: 2,
        local_same_key_overrides_parent: true,
        unrelated_relations_expand_scope: false
      },
      results: queries.map((query) => ({
        query,
        facts: [],
        entities: [{
          id: 'synthetic-hook-context',
          key: 'synthetic:hook:context',
          name: 'HOOK-CONTEXT-731',
          type: 'TestKnowledge',
          summary: 'HOOK-CONTEXT-731 proves only that hook context reached Claude.',
          defined_project_id: 'hotel-b',
          confirmation_status: 'confirmed'
        }]
      }))
    };
  },
  async close() {}
};

const server = createMcpServer(app);
const transport = new StdioServerTransport();
let closing = null;
const close = async () => {
  if (!closing) {
    closing = (async () => {
      await server.close();
      await app.close();
    })();
  }
  return closing;
};

server.server.onclose = () => { void close(); };
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void close(); });
}
process.stdin.once('end', () => { void close(); });
await server.connect(transport);
