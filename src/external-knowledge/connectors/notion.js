const NOTION_API_ROOT = 'https://api.notion.com';
const NOTION_API_VERSION = '2026-03-11';

export function createNotionConnector({ fetchImpl = globalThis.fetch } = {}) {
  const request = notionRequester(fetchImpl);
  return {
    type: 'notion',
    name: 'Notion',
    capabilities: ['discover', 'sync', 'retrieve'],

    async check(context) {
      notionSources(context.source);
      const user = await request(context, 'GET', '/v1/users/me');
      return {
        status: 'ready',
        capabilities: ['discover', 'sync', 'retrieve'],
        account: { id: user.id ?? null, name: user.name ?? null },
        apiVersion: NOTION_API_VERSION
      };
    },

    async discover(context) {
      const body = {
        page_size: pageSize(context.limit),
        filter: { property: 'object', value: 'page' },
        ...(context.cursor ? { start_cursor: context.cursor } : {}),
        ...(context.query ? { query: context.query } : {})
      };
      const result = await request(context, 'POST', '/v1/search', body);
      return {
        items: (result.results ?? []).map(pageSummary),
        nextCursor: result.next_cursor ?? null,
        hasMore: result.has_more === true
      };
    },

    async sync(context) {
      const sources = notionSources(context.source);
      const state = decodeCursor(context.cursor);
      if (state.sourceIndex >= sources.length) return emptySyncPage();
      const current = sources[state.sourceIndex];
      if (current.kind === 'page') {
        const page = await request(
          context,
          'GET',
          `/v1/pages/${encodeURIComponent(current.id)}`
        );
        const nextCursor = nextSourceCursor(state.sourceIndex, sources.length);
        if (page.in_trash === true) {
          return {
            items: [],
            deleted: [page.id ?? current.id],
            nextCursor,
            hasMore: nextCursor !== null
          };
        }
        return {
          items: [await notionPageDocument(context, request, page)],
          deleted: [],
          nextCursor,
          hasMore: nextCursor !== null
        };
      }
      const query = await request(
        context,
        'POST',
        `/v1/data_sources/${encodeURIComponent(current.id)}/query`,
        {
          page_size: pageSize(context.limit),
          ...(state.startCursor ? { start_cursor: state.startCursor } : {})
        }
      );
      const activePages = (query.results ?? []).filter((page) => page.in_trash !== true);
      const items = [];
      for (const page of activePages) {
        items.push(await notionPageDocument(context, request, page));
      }
      const nextCursor = query.has_more === true
        ? encodeCursor({ sourceIndex: state.sourceIndex, startCursor: query.next_cursor })
        : nextSourceCursor(state.sourceIndex, sources.length);
      return {
        items,
        deleted: (query.results ?? [])
          .filter((page) => page.in_trash === true)
          .map(({ id }) => id),
        nextCursor,
        hasMore: nextCursor !== null
      };
    },

    async retrieve(context) {
      const sources = notionSources(context.source);
      const result = await request(context, 'POST', '/v1/search', {
        query: requiredString(context.query, 'Notion query'),
        page_size: pageSize(context.limit),
        filter: { property: 'object', value: 'page' }
      });
      const allowed = (result.results ?? [])
        .filter((page) => page.in_trash !== true && notionPageIsBound(page, sources))
        .slice(0, pageSize(context.limit));
      const items = [];
      for (const page of allowed) {
        items.push(await notionPageDocument(context, request, page));
      }
      return { items };
    }
  };
}

function notionRequester(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Notion fetch is unavailable');
  return async (context, method, path, body = undefined) => {
    if (!['GET', 'POST'].includes(method)) {
      throw new TypeError('Notion connector only permits read operations');
    }
    const token = credentialFromEnvironment(context, 'tokenEnv', 'Notion token');
    const response = await fetchImpl(`${NOTION_API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_API_VERSION,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMilliseconds(context.config?.timeoutMs))
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        payload.message ?? `Notion API request failed with status ${response.status}`
      );
      error.status = response.status;
      throw error;
    }
    return payload;
  };
}

async function notionPageDocument(context, request, page) {
  const id = requiredString(page.id, 'Notion page id');
  const markdown = await request(
    context,
    'GET',
    `/v1/pages/${encodeURIComponent(id)}/markdown`
  );
  let content = typeof markdown.markdown === 'string' ? markdown.markdown : '';
  const unresolved = [];
  for (const blockId of (markdown.unknown_block_ids ?? []).slice(0, 100)) {
    try {
      const block = await request(
        context,
        'GET',
        `/v1/pages/${encodeURIComponent(blockId)}/markdown`
      );
      if (typeof block.markdown === 'string' && block.markdown.trim()) {
        content += `\n\n${block.markdown}`;
      }
    } catch (error) {
      if (error.status !== 404) throw error;
      unresolved.push(blockId);
    }
  }
  if (!content.trim()) content = `# ${notionTitle(page)}`;
  return {
    id,
    title: notionTitle(page),
    content,
    url: onlineUrl(page.url),
    updatedAt: dateTimeOrNull(page.last_edited_time),
    metadata: {
      notionObject: page.object ?? 'page',
      parent: jsonObject(page.parent),
      markdownTruncated: markdown.truncated === true,
      unresolvedBlockIds: unresolved
    }
  };
}

function notionSources(source, { allowEmpty = false } = {}) {
  const pageIds = idArray(source?.pageIds, 'Notion pageIds');
  const dataSourceIds = idArray(source?.dataSourceIds, 'Notion dataSourceIds');
  const sources = [
    ...pageIds.map((id) => ({ kind: 'page', id })),
    ...dataSourceIds.map((id) => ({ kind: 'data_source', id }))
  ];
  if (!allowEmpty && sources.length === 0) {
    throw new TypeError('Notion source requires pageIds or dataSourceIds');
  }
  return sources;
}

function notionPageIsBound(page, sources) {
  if (sources.some(({ kind, id }) => kind === 'page' && id === page.id)) return true;
  const parentId = page.parent?.data_source_id ?? page.parent?.database_id;
  return sources.some(({ kind, id }) => kind === 'data_source' && id === parentId);
}

function pageSummary(page) {
  return {
    id: page.id,
    title: notionTitle(page),
    type: 'page',
    url: onlineUrl(page.url),
    updatedAt: dateTimeOrNull(page.last_edited_time),
    metadata: { parent: jsonObject(page.parent) }
  };
}

function notionTitle(page) {
  for (const property of Object.values(page.properties ?? {})) {
    if (property?.type !== 'title' || !Array.isArray(property.title)) continue;
    const title = property.title.map((item) => item?.plain_text ?? '').join('').trim();
    if (title) return title;
  }
  return page.title?.map?.((item) => item?.plain_text ?? '').join('').trim()
    || page.id
    || 'Untitled Notion page';
}

function nextSourceCursor(index, length) {
  return index + 1 < length
    ? encodeCursor({ sourceIndex: index + 1, startCursor: null })
    : null;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return { sourceIndex: 0, startCursor: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed.sourceIndex) || parsed.sourceIndex < 0) throw new Error();
    if (parsed.startCursor !== null && typeof parsed.startCursor !== 'string') throw new Error();
    return parsed;
  } catch {
    throw new TypeError('Invalid Notion synchronization cursor');
  }
}

function emptySyncPage() {
  return { items: [], deleted: [], nextCursor: null, hasMore: false };
}

function credentialFromEnvironment(context, key, label) {
  const name = context.config?.[key];
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new TypeError(`${label} environment variable name is required`);
  }
  const value = context.env?.[name];
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

function pageSize(value) {
  if (value === undefined || value === null) return 100;
  if (!Number.isInteger(value) || value <= 0) throw new TypeError('Notion page size is invalid');
  return Math.min(value, 100);
}

function timeoutMilliseconds(value) {
  if (value === undefined || value === null) return 30_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) {
    throw new TypeError('Notion timeoutMs must be between 1000 and 120000');
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
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

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}
