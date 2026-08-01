import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const LOCAL_CURSOR_PREFIX = 'fuli-mcp-v1:';

export function createMcpConnector({ openSession = defaultOpenSession } = {}) {
  return {
    type: 'mcp',
    name: 'MCP',
    capabilities: ['discover', 'sync', 'retrieve'],

    async check(context) {
      return withSession(openSession, context, async (client) => {
        const capabilities = client.getServerCapabilities?.() ?? {};
        const supported = [];
        if (capabilities.resources) {
          supported.push('discover', 'sync');
        }
        if (capabilities.tools && context.mode !== 'mirror') {
          const searchTool = context.config?.searchTool ?? 'search';
          const fetchTool = context.config?.fetchTool ?? 'fetch';
          const listed = await client.listTools({});
          const tools = listed.tools ?? [];
          assertReadTool(tools, searchTool);
          if (tools.some(({ name }) => name === fetchTool)) {
            assertReadTool(tools, fetchTool);
          }
          supported.push('retrieve');
        }
        return {
          status: 'ready',
          capabilities: supported,
          server: client.getServerVersion?.() ?? null
        };
      });
    },

    async discover(context) {
      return withSession(openSession, context, async (client) => {
        const listed = await resourcePage(client, context);
        return {
          items: listed.resources.map((resource) => ({
            id: resource.uri,
            title: resource.name ?? resource.title ?? resource.uri,
            type: 'resource',
            metadata: { mimeType: resource.mimeType ?? null }
          })),
          nextCursor: listed.nextCursor,
          hasMore: listed.nextCursor !== null
        };
      });
    },

    async sync(context) {
      return withSession(openSession, context, async (client) => {
        const explicitUris = stringArray(context.source?.resourceUris);
        let resources;
        let nextCursor = null;
        if (explicitUris.length) {
          const offset = explicitResourceOffset(context.cursor);
          const limit = connectorLimit(context.limit);
          resources = explicitUris.slice(offset, offset + limit)
            .map((uri) => ({ uri, name: uri }));
          const nextOffset = offset + resources.length;
          nextCursor = nextOffset < explicitUris.length
            ? encodeLocalCursor({ mode: 'explicit', offset: nextOffset })
            : null;
        } else {
          const listed = await resourcePage(client, context);
          resources = listed.resources;
          nextCursor = listed.nextCursor;
        }
        const items = [];
        for (const resource of resources) {
          const read = await client.readResource({ uri: resource.uri });
          const content = resourceText(read.contents ?? []);
          if (!content) continue;
          items.push({
            id: resource.uri,
            title: resource.name ?? resource.title ?? resource.uri,
            content,
            url: onlineUrl(resource.uri),
            updatedAt: null,
            metadata: {
              mimeType: resource.mimeType ?? firstMimeType(read.contents) ?? null,
              mcpUri: resource.uri
            }
          });
        }
        return {
          items,
          deleted: [],
          nextCursor,
          hasMore: Boolean(nextCursor)
        };
      });
    },

    async retrieve(context) {
      return withSession(openSession, context, async (client) => {
        const searchTool = context.config?.searchTool ?? 'search';
        const fetchTool = context.config?.fetchTool ?? 'fetch';
        const listed = await client.listTools({});
        const tools = listed.tools ?? [];
        assertReadTool(tools, searchTool);
        const hasFetch = tools.some(({ name }) => name === fetchTool);
        if (hasFetch) assertReadTool(tools, fetchTool);
        const searchResult = await client.callTool({
          name: searchTool,
          arguments: {
            ...(plainObject(context.source?.searchArguments) ?? {}),
            [context.config?.searchArgumentName ?? 'query']: context.query
          }
        });
        const candidates = toolItems(searchResult).slice(0, context.limit);
        const items = [];
        for (const [index, candidate] of candidates.entries()) {
          let item = candidate;
          if (!itemContent(item) && hasFetch) {
            const identifier = item?.id ?? item?.uri ?? item?.url;
            if (identifier) {
              const fetched = await client.callTool({
                name: fetchTool,
                arguments: {
                  [context.config?.fetchArgumentName ?? 'id']: identifier
                }
              });
              item = mergeToolItem(item, toolItems(fetched)[0] ?? toolPayload(fetched));
            }
          }
          const normalized = normalizeToolItem(item, context.query, index);
          if (normalized) items.push(normalized);
        }
        return { items };
      });
    }
  };
}

async function defaultOpenSession({ config = {}, env = process.env }) {
  const client = new Client({ name: 'fuli-external-knowledge', version: '1.0.0' });
  const transport = config.transport === 'stdio'
    ? stdioTransport(config, env)
    : httpTransport(config, env);
  await client.connect(transport);
  let closed = false;
  return {
    client,
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    }
  };
}

function httpTransport(config, env) {
  const url = mcpHttpUrl(config.url);
  const headers = resolveHeaderEnvironment(config, env);
  return new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length ? { headers } : undefined
  });
}

function stdioTransport(config, env) {
  const command = requiredString(config.command, 'MCP stdio command');
  const args = stringArray(config.args);
  const mappedEnvironment = Object.create(null);
  for (const [childName, sourceName] of Object.entries(
    plainObject(config.envMapping) ?? {}
  )) {
    assertEnvironmentName(childName);
    assertEnvironmentName(sourceName);
    mappedEnvironment[childName] = requiredEnvironment(env, sourceName);
  }
  return new StdioClientTransport({
    command,
    args,
    env: { ...getDefaultEnvironment(), ...mappedEnvironment },
    ...(config.cwd ? { cwd: requiredString(config.cwd, 'MCP stdio cwd') } : {}),
    stderr: 'pipe'
  });
}

function resolveHeaderEnvironment(config, env) {
  const headers = Object.create(null);
  if (config.tokenEnv) {
    assertEnvironmentName(config.tokenEnv);
    headers.Authorization = `Bearer ${requiredEnvironment(env, config.tokenEnv)}`;
  }
  for (const [header, sourceName] of Object.entries(
    plainObject(config.headerEnv) ?? {}
  )) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(header)) {
      throw new TypeError(`Invalid MCP header name: ${header}`);
    }
    assertEnvironmentName(sourceName);
    headers[header] = requiredEnvironment(env, sourceName);
  }
  return headers;
}

async function withSession(openSession, context, operation) {
  const session = await openSession(context);
  try {
    return await operation(session.client);
  } finally {
    await session.close();
  }
}

function filterResources(resources, source = {}) {
  const prefix = source?.resourceUriPrefix;
  return prefix
    ? resources.filter(({ uri }) => typeof uri === 'string' && uri.startsWith(prefix))
    : resources;
}

async function resourcePage(client, context) {
  const state = resourcePageCursor(context.cursor);
  const listed = await client.listResources(
    state.serverCursor ? { cursor: state.serverCursor } : {}
  );
  const resources = filterResources(listed.resources ?? [], context.source);
  const limit = connectorLimit(context.limit);
  const page = resources.slice(state.offset, state.offset + limit);
  const nextOffset = state.offset + page.length;
  const nextCursor = nextOffset < resources.length
    ? encodeLocalCursor({
        mode: 'resource-page',
        serverCursor: state.serverCursor,
        offset: nextOffset
      })
    : listed.nextCursor ?? null;
  return { resources: page, nextCursor };
}

function resourcePageCursor(value) {
  if (!value) return { serverCursor: null, offset: 0 };
  const local = decodeLocalCursor(value);
  if (!local) return { serverCursor: value, offset: 0 };
  if (local.mode !== 'resource-page' ||
      (local.serverCursor !== null && typeof local.serverCursor !== 'string') ||
      !Number.isInteger(local.offset) || local.offset < 0) {
    throw new TypeError('Invalid MCP resource cursor');
  }
  return { serverCursor: local.serverCursor, offset: local.offset };
}

function explicitResourceOffset(value) {
  if (!value) return 0;
  const local = decodeLocalCursor(value);
  if (!local || local.mode !== 'explicit' ||
      !Number.isInteger(local.offset) || local.offset < 0) {
    throw new TypeError('Invalid MCP explicit-resource cursor');
  }
  return local.offset;
}

function encodeLocalCursor(value) {
  return `${LOCAL_CURSOR_PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function decodeLocalCursor(value) {
  if (typeof value !== 'string' || !value.startsWith(LOCAL_CURSOR_PREFIX)) return null;
  try {
    return JSON.parse(
      Buffer.from(value.slice(LOCAL_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    );
  } catch {
    throw new TypeError('Invalid MCP local cursor');
  }
}

function connectorLimit(value) {
  if (value === undefined || value === null) return 100;
  if (!Number.isInteger(value) || value <= 0 || value > 100) {
    throw new TypeError('MCP limit must be between 1 and 100');
  }
  return value;
}

function resourceText(contents) {
  return contents.map((item) => {
    if (typeof item.text === 'string') return item.text;
    if (typeof item.blob === 'string' && isTextMime(item.mimeType)) {
      return Buffer.from(item.blob, 'base64').toString('utf8');
    }
    return '';
  }).filter(Boolean).join('\n\n');
}

function firstMimeType(contents = []) {
  return contents.find(({ mimeType }) => mimeType)?.mimeType ?? null;
}

function isTextMime(mimeType) {
  return typeof mimeType === 'string' && (
    mimeType.startsWith('text/') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('yaml')
  );
}

function assertReadTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new TypeError(`MCP read tool is unavailable: ${name}`);
  if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) {
    throw new TypeError(`MCP tool is not declared read-only: ${name}`);
  }
}

function toolItems(result) {
  const payload = toolPayload(result);
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') {
    return typeof payload === 'string' && payload.trim() ? [{ content: payload }] : [];
  }
  for (const key of ['items', 'results', 'hits', 'data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [payload];
}

function toolPayload(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content ?? [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map(({ text }) => text)
    .join('\n');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeToolItem(value, query, index) {
  if (typeof value === 'string') {
    return {
      id: `mcp:${index + 1}`,
      title: query,
      content: value,
      url: null,
      updatedAt: null,
      metadata: {}
    };
  }
  if (!value || typeof value !== 'object') return null;
  const content = itemContent(value);
  if (!content) return null;
  const id = String(value.id ?? value.uri ?? value.url ?? `mcp:${index + 1}`);
  return {
    id,
    title: String(value.title ?? value.name ?? id),
    content,
    url: onlineUrl(value.url ?? value.uri),
    updatedAt: dateTimeOrNull(value.updatedAt ?? value.updated_at),
    metadata: plainObject(value.metadata) ?? {}
  };
}

function itemContent(value) {
  if (!value || typeof value !== 'object') return '';
  for (const key of ['content', 'text', 'snippet', 'description', 'markdown']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key];
  }
  return '';
}

function mergeToolItem(left, right) {
  if (!left || typeof left !== 'object') return right;
  if (!right || typeof right !== 'object') return left;
  return { ...left, ...right };
}

function mcpHttpUrl(value) {
  const url = new URL(requiredString(value, 'MCP URL'));
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new TypeError('MCP URL must use HTTPS, or HTTP on loopback, and cannot contain credentials');
  }
  return url;
}

function onlineUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function dateTimeOrNull(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError('Expected an array of strings');
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function assertEnvironmentName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new TypeError('Environment variable name is invalid');
  }
}

function requiredEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`Required environment variable is unavailable: ${name}`);
  }
  return value;
}
