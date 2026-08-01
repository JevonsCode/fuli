import { createCustomConnector } from './connectors/custom.js';
import { createFeishuConnector } from './connectors/feishu.js';
import { createMcpConnector } from './connectors/mcp.js';
import { createNotionConnector } from './connectors/notion.js';
import { createRetrievalApiConnector } from './connectors/retrieval-api.js';

export function createConnectorCatalog({
  customConnectorDirectory,
  fetchImpl = globalThis.fetch,
  mcpOpenSession,
  sleep
}) {
  const connectors = [
    withMetadata(createMcpConnector({ openSession: mcpOpenSession }), {
      status: 'supported',
      trust: 'remote_protocol',
      description: 'MCP resources and explicitly configured read tools.'
    }),
    withMetadata(createNotionConnector({ fetchImpl }), {
      status: 'supported',
      trust: 'official_read_api',
      description: 'Notion pages and data sources through the current markdown API.'
    }),
    withMetadata(createFeishuConnector({ fetchImpl, sleep }), {
      status: 'supported',
      trust: 'official_read_api',
      description: 'Feishu/Lark wiki discovery and read-only docx content.',
      limitations: ['docx_content_only', 'wiki_search_requires_user_access_token']
    }),
    withMetadata(createRetrievalApiConnector({ fetchImpl }), {
      status: 'supported',
      trust: 'compatible_read_api',
      description: 'Dify-compatible retrieval API for external RAG knowledge bases.',
      limitations: ['live_retrieval_only', 'requires_stable_document_metadata_for_best_provenance']
    }),
    withMetadata(createCustomConnector({ directory: customConnectorDirectory }), {
      status: 'advanced',
      trust: 'trusted_local_code',
      description: 'A local ESM connector module explicitly installed by the user.'
    })
  ];
  const byType = new Map(connectors.map((connector) => [connector.type, connector]));
  return {
    get(type) {
      return byType.get(type) ?? null;
    },
    list() {
      return connectors.map(({ metadata }) => structuredClone(metadata));
    }
  };
}

function withMetadata(connector, metadata) {
  const descriptor = Object.freeze({
    type: connector.type,
    name: connector.name,
    capabilities: [...connector.capabilities],
    ...metadata
  });
  return Object.assign(connector, { metadata: descriptor });
}
