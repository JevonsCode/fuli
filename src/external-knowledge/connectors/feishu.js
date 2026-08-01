const API_ROOTS = Object.freeze({
  cn: 'https://open.feishu.cn',
  global: 'https://open.larksuite.com'
});

export function createFeishuConnector({
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  const tokenCache = new Map();
  let nextRawRequestAt = 0;
  const request = feishuRequester(fetchImpl, tokenCache);

  async function readDocument(context, node) {
    if (normalizedObjectType(node.obj_type) !== 'docx') return null;
    const interval = rawContentInterval(context.config?.rawContentIntervalMs);
    const wait = nextRawRequestAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextRawRequestAt = Date.now() + interval;
    const result = await request(
      context,
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(node.obj_token)}/raw_content`,
      undefined,
      { query: { lang: '0' } }
    );
    const content = result.content;
    if (typeof content !== 'string' || !content.trim()) return null;
    return {
      id: node.node_token ?? node.node_id,
      title: node.title || node.node_token || node.node_id,
      content,
      url: nodeUrl(node, context.source),
      updatedAt: epochDateTime(node.obj_edit_time),
      metadata: {
        feishuSpaceId: node.space_id ?? context.source?.spaceId ?? null,
        feishuNodeToken: node.node_token ?? node.node_id,
        feishuObjectToken: node.obj_token,
        feishuObjectType: normalizedObjectType(node.obj_type)
      }
    };
  }

  async function resolveNode(context, token) {
    const result = await request(
      context,
      'GET',
      '/open-apis/wiki/v2/spaces/get_node',
      undefined,
      { query: { token } }
    );
    return result.node;
  }

  return {
    type: 'feishu',
    name: '飞书 / Lark',
    capabilities: ['discover', 'sync', 'retrieve'],

    async check(context) {
      const source = feishuSource(context.source);
      if (source.nodeTokens.length) {
        await resolveNode(context, source.nodeTokens[0]);
      } else if (source.spaceId) {
        await request(
          context,
          'GET',
          `/open-apis/wiki/v2/spaces/${encodeURIComponent(source.spaceId)}`
        );
      } else {
        await accessToken(context, fetchImpl, tokenCache);
      }
      return {
        status: 'ready',
        capabilities: ['discover', 'sync', 'retrieve'],
        region: region(context.config?.region)
      };
    },

    async discover(context) {
      const source = feishuSource(context.source, { allowEmpty: true });
      if (context.query) {
        const result = await searchWiki(context, request, source, context.query, context.cursor);
        return {
          items: (result.items ?? []).map(nodeSummary),
          nextCursor: result.page_token ?? null,
          hasMore: result.has_more === true
        };
      }
      if (!source.spaceId) {
        throw new TypeError('Feishu discovery without a query requires spaceId');
      }
      const listed = await listChildren(context, request, source, {
        parent: source.rootNodeToken,
        pageToken: context.cursor
      });
      return {
        items: (listed.items ?? []).map(nodeSummary),
        nextCursor: listed.page_token ?? null,
        hasMore: listed.has_more === true
      };
    },

    async sync(context) {
      const source = feishuSource(context.source);
      if (source.nodeTokens.length) {
        const state = decodeCursor(context.cursor, 'nodes', {
          mode: 'nodes',
          index: 0
        });
        if (state.index >= source.nodeTokens.length) return emptyPage();
        const node = await resolveNode(context, source.nodeTokens[state.index]);
        const document = await readDocument(context, node);
        const nextCursor = state.index + 1 < source.nodeTokens.length
          ? encodeCursor({ mode: 'nodes', index: state.index + 1 })
          : null;
        return {
          items: document ? [document] : [],
          deleted: [],
          nextCursor,
          hasMore: nextCursor !== null,
          unsupported: document ? [] : [node.obj_type]
        };
      }
      const initial = {
        mode: 'tree',
        rootPending: Boolean(source.rootNodeToken),
        queue: [source.rootNodeToken ?? null],
        pageToken: null,
        discoveredChildren: []
      };
      const state = decodeCursor(context.cursor, 'tree', initial);
      if (state.rootPending) {
        const node = await resolveNode(context, source.rootNodeToken);
        const document = await readDocument(context, node);
        const nextCursor = encodeCursor({ ...state, rootPending: false });
        return {
          items: document ? [document] : [],
          deleted: [],
          nextCursor,
          hasMore: true,
          unsupported: document ? [] : [node.obj_type]
        };
      }
      if (state.queue.length === 0) return emptyPage();
      const parent = state.queue[0];
      const listed = await listChildren(context, request, source, {
        parent,
        pageToken: state.pageToken,
        limit: context.limit
      });
      const nodes = listed.items ?? [];
      const items = [];
      const unsupported = [];
      for (const node of nodes) {
        const document = await readDocument(context, node);
        if (document) items.push(document);
        else unsupported.push(node.obj_type);
      }
      const children = [
        ...state.discoveredChildren,
        ...nodes.filter(({ has_child: hasChild }) => hasChild === true)
          .map(({ node_token: token }) => token)
          .filter(Boolean)
      ];
      const hasMoreForParent = listed.has_more === true;
      const queue = hasMoreForParent
        ? state.queue
        : [...state.queue.slice(1), ...children];
      const nextState = {
        mode: 'tree',
        rootPending: false,
        queue,
        pageToken: hasMoreForParent ? listed.page_token : null,
        discoveredChildren: hasMoreForParent ? children : []
      };
      const nextCursor = queue.length ? encodeCursor(nextState) : null;
      return {
        items,
        deleted: [],
        nextCursor,
        hasMore: nextCursor !== null,
        unsupported
      };
    },

    async retrieve(context) {
      const source = feishuSource(context.source);
      const result = await searchWiki(context, request, source, context.query, null, context.limit);
      const items = [];
      for (const node of (result.items ?? []).slice(0, pageSize(context.limit))) {
        const document = await readDocument(context, node);
        if (document) items.push(document);
      }
      return { items };
    }
  };
}

function feishuRequester(fetchImpl, tokenCache) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Feishu fetch is unavailable');
  return async (context, method, path, body = undefined, { query = {} } = {}) => {
    const allowedPost = path === '/open-apis/wiki/v2/nodes/search';
    if (method !== 'GET' && !(method === 'POST' && allowedPost)) {
      throw new TypeError('Feishu connector only permits knowledge read operations');
    }
    const url = new URL(`${apiRoot(context.config?.region)}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
    const token = await accessToken(context, fetchImpl, tokenCache);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMilliseconds(context.config?.timeoutMs))
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 0) {
      throw new Error(payload.msg ?? `Feishu API request failed with status ${response.status}`);
    }
    return payload.data ?? {};
  };
}

async function accessToken(context, fetchImpl, tokenCache) {
  const directName = context.config?.accessTokenEnv;
  if (directName) return environmentValue(context.env, directName, 'Feishu access token');
  const appIdName = context.config?.appIdEnv;
  const appSecretName = context.config?.appSecretEnv;
  const appId = environmentValue(context.env, appIdName, 'Feishu app ID');
  const appSecret = environmentValue(context.env, appSecretName, 'Feishu app secret');
  const cacheKey = `${region(context.config?.region)}:${appIdName}:${appSecretName}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const response = await fetchImpl(
    `${apiRoot(context.config?.region)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(timeoutMilliseconds(context.config?.timeoutMs))
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(payload.msg ?? 'Feishu tenant access token request failed');
  }
  tokenCache.set(cacheKey, {
    value: payload.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(payload.expire ?? 7200)) * 1_000
  });
  return payload.tenant_access_token;
}

async function listChildren(context, request, source, {
  parent = null,
  pageToken = null,
  limit = 50
}) {
  return request(
    context,
    'GET',
    `/open-apis/wiki/v2/spaces/${encodeURIComponent(source.spaceId)}/nodes`,
    undefined,
    {
      query: {
        page_size: String(pageSize(limit)),
        ...(pageToken ? { page_token: pageToken } : {}),
        ...(parent ? { parent_node_token: parent } : {})
      }
    }
  );
}

async function searchWiki(context, request, source, query, pageToken, limit = 50) {
  const normalizedQuery = requiredString(query, 'Feishu query').slice(0, 50);
  return request(
    context,
    'POST',
    '/open-apis/wiki/v2/nodes/search',
    {
      query: normalizedQuery,
      ...(source.spaceId ? { space_id: source.spaceId } : {}),
      ...(source.rootNodeToken ? { node_id: source.rootNodeToken } : {})
    },
    {
      query: {
        page_size: String(pageSize(limit)),
        ...(pageToken ? { page_token: pageToken } : {})
      }
    }
  );
}

function feishuSource(source, { allowEmpty = false } = {}) {
  const nodeTokens = idArray(source?.nodeTokens, 'Feishu nodeTokens');
  const spaceId = optionalString(source?.spaceId);
  const rootNodeToken = optionalString(source?.rootNodeToken);
  if (!allowEmpty && !nodeTokens.length && !spaceId) {
    throw new TypeError('Feishu source requires nodeTokens or spaceId');
  }
  if (rootNodeToken && !spaceId) {
    throw new TypeError('Feishu rootNodeToken requires spaceId');
  }
  return { nodeTokens, spaceId, rootNodeToken };
}

function nodeSummary(node) {
  return {
    id: node.node_token ?? node.node_id,
    title: node.title ?? node.node_token ?? node.node_id,
    type: normalizedObjectType(node.obj_type),
    url: onlineUrl(node.url),
    updatedAt: epochDateTime(node.obj_edit_time),
    metadata: {
      spaceId: node.space_id ?? null,
      objectToken: node.obj_token ?? null,
      hasChild: node.has_child === true
    }
  };
}

function nodeUrl(node, source) {
  const direct = onlineUrl(node.url);
  if (direct) return direct;
  const base = onlineUrl(source?.webBaseUrl);
  const token = node.node_token ?? node.node_id;
  return base && token ? new URL(`/wiki/${encodeURIComponent(token)}`, base).toString() : null;
}

function normalizedObjectType(value) {
  const numeric = {
    1: 'doc',
    2: 'sheet',
    3: 'bitable',
    4: 'mindnote',
    5: 'file',
    7: 'wiki',
    8: 'docx',
    9: 'folder',
    10: 'catalog',
    11: 'slides'
  };
  return numeric[value] ?? String(value ?? 'unknown').toLowerCase();
}

function encodeCursor(value) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  if (encoded.length > 64_000) {
    throw new Error('Feishu traversal cursor is too large; bind narrower root nodes');
  }
  return encoded;
}

function decodeCursor(value, mode, fallback) {
  if (!value) return structuredClone(fallback);
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.mode !== mode) throw new Error();
    if (mode === 'nodes' && (!Number.isInteger(parsed.index) || parsed.index < 0)) throw new Error();
    if (mode === 'tree' && !Array.isArray(parsed.queue)) throw new Error();
    return parsed;
  } catch {
    throw new TypeError('Invalid Feishu synchronization cursor');
  }
}

function emptyPage() {
  return {
    items: [],
    deleted: [],
    nextCursor: null,
    hasMore: false,
    unsupported: []
  };
}

function region(value) {
  const normalized = value ?? 'cn';
  if (!Object.hasOwn(API_ROOTS, normalized)) {
    throw new TypeError('Feishu region must be cn or global');
  }
  return normalized;
}

function apiRoot(value) {
  return API_ROOTS[region(value)];
}

function environmentValue(env, name, label) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new TypeError(`${label} environment variable name is required`);
  }
  const value = env?.[name];
  if (typeof value !== 'string' || !value) {
    throw new TypeError(`${label} environment variable is unavailable: ${name}`);
  }
  return value;
}

function idArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${label} must be an array of nonempty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function rawContentInterval(value) {
  if (value === undefined || value === null) return 210;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new TypeError('Feishu rawContentIntervalMs must be between 0 and 10000');
  }
  return value;
}

function timeoutMilliseconds(value) {
  if (value === undefined || value === null) return 30_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new TypeError('Feishu timeoutMs must be between 1000 and 120000');
  }
  return value;
}

function pageSize(value) {
  if (value === undefined || value === null) return 50;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('Feishu page size is invalid');
  return Math.min(value, 50);
}

function epochDateTime(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : null;
}

function onlineUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}
