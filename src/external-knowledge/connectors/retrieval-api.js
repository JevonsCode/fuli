import { createHash } from 'node:crypto';

const DEFAULT_SCORE_THRESHOLD = 0.5;
const MAX_KNOWLEDGE_BASES = 32;

export function createRetrievalApiConnector({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Retrieval API fetch is unavailable');
  }

  async function retrieve(context, { checking = false } = {}) {
    const endpoint = retrievalEndpoint(context.config?.url);
    const knowledgeIds = idArray(context.source?.knowledgeIds, 'knowledgeIds');
    const limit = checking ? 1 : positiveInteger(context.limit ?? 12, 'limit', 100);
    const query = checking
      ? 'FULI connection check'
      : requiredString(context.query, 'Retrieval query', 2_000);
    const results = await Promise.all(knowledgeIds.map(async (knowledgeId) => {
      const payload = await request(fetchImpl, endpoint, context, {
        knowledge_id: knowledgeId,
        query,
        retrieval_setting: {
          top_k: limit,
          score_threshold: scoreThreshold(context.config?.scoreThreshold)
        }
      });
      if (!Array.isArray(payload.records)) {
        throw new TypeError('Retrieval API response records must be an array');
      }
      return payload.records.slice(0, limit).map((record, index) =>
        retrievalDocument(record, { knowledgeId, index })
      );
    }));
    return {
      items: results.flat()
        .sort((left, right) => (right.metadata.score ?? 0) - (left.metadata.score ?? 0))
        .slice(0, limit)
    };
  }

  return {
    type: 'retrieval_api',
    name: 'RAG Retrieval API',
    capabilities: ['retrieve'],

    async check(context) {
      await retrieve(context, { checking: true });
      return {
        status: 'ready',
        capabilities: ['retrieve'],
        protocol: 'dify_external_knowledge_v1'
      };
    },

    retrieve
  };
}

async function request(fetchImpl, endpoint, context, body) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  const tokenName = optionalEnvironmentName(context.config?.tokenEnv, 'tokenEnv');
  if (tokenName) {
    const token = context.env?.[tokenName];
    if (typeof token !== 'string' || !token) {
      throw new TypeError(`Retrieval API token environment variable is unavailable: ${tokenName}`);
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMilliseconds(context.config?.timeoutMs))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.message ?? payload?.error ??
      `Retrieval API request failed with status ${response.status}`
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Retrieval API response must be an object');
  }
  return payload;
}

function retrievalDocument(record, { knowledgeId, index }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('Retrieval API records must be objects');
  }
  const metadata = jsonObject(record.metadata);
  const content = requiredString(record.content, 'Retrieval record content', 1_000_000);
  const title = firstString(
    record.title,
    metadata.title,
    metadata.document_name,
    metadata.filename,
    `Knowledge result ${index + 1}`
  );
  const sourceId = firstString(
    metadata.segment_id,
    metadata.chunk_id,
    metadata.document_id,
    metadata.id,
    metadata.path,
    metadata.url,
    metadata.source_url
  ) ?? createHash('sha256')
    .update(`${knowledgeId}\0${title}\0${content}`)
    .digest('hex');
  const combinedId = `${knowledgeId}:${sourceId}`;
  return {
    id: combinedId.length <= 512
      ? combinedId
      : `retrieval:${createHash('sha256').update(combinedId).digest('hex')}`,
    title,
    content,
    url: onlineUrl(firstString(metadata.url, metadata.source_url)),
    updatedAt: dateTime(firstString(metadata.updated_at, metadata.updatedAt)),
    metadata: {
      ...metadata,
      knowledgeId,
      score: finiteNumber(record.score)
    }
  };
}

function retrievalEndpoint(value) {
  const raw = requiredString(value, 'Retrieval API URL', 2_048);
  const url = new URL(raw);
  const loopback = url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password) {
    throw new TypeError('Retrieval API URL must use HTTPS or loopback HTTP without credentials');
  }
  return url.toString();
}

function idArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_KNOWLEDGE_BASES) {
    throw new TypeError(`${label} must contain 1 to ${MAX_KNOWLEDGE_BASES} IDs`);
  }
  const ids = value.map((item) => requiredString(item, `${label} item`, 512));
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} must be unique`);
  return ids;
}

function scoreThreshold(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SCORE_THRESHOLD;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('scoreThreshold must be a number from 0 to 1');
  }
  return value;
}

function timeoutMilliseconds(value) {
  if (value === undefined || value === null) return 20_000;
  return positiveInteger(value, 'timeoutMs', 120_000);
}

function optionalEnvironmentName(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new TypeError(`${label} must be an environment variable name`);
  }
  return value;
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}

function onlineUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function dateTime(value) {
  return value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function requiredString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${label} is too long`);
  return normalized;
}

function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}
