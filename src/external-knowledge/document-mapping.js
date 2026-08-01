import { createHash } from 'node:crypto';

import { detectSensitiveContent } from '../security/sensitive-content.js';

const MAX_CHUNK_LENGTH = 6_000;
const MAX_EXCERPT_LENGTH = 2_048;

export function normalizeExternalDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Connector items must be objects');
  }
  const id = requiredString(value.id, 'Connector item id', 512);
  const title = requiredString(value.title ?? value.name ?? id, 'Connector item title', 512);
  const content = requiredString(value.content, 'Connector item content', 1_000_000);
  const url = optionalOnlineUrl(value.url);
  const updatedAt = optionalDateTime(value.updatedAt, 'Connector item updatedAt');
  const metadata = plainJsonObject(value.metadata ?? {}, 'Connector item metadata');
  if (detectSensitiveContent(JSON.stringify({ title, content, metadata })).restricted) {
    throw new TypeError('Connector item contains credentials and cannot be retrieved or stored');
  }
  return { id, title, content, url, updatedAt, metadata };
}

export function externalDocumentHash(document) {
  return createHash('sha256').update(JSON.stringify({
    title: document.title,
    content: document.content,
    url: document.url,
    updatedAt: document.updatedAt,
    metadata: document.metadata
  })).digest('hex');
}

export function externalDocumentStateKey(id) {
  return createHash('sha256').update(`external-document:${id}`).digest('hex');
}

export function externalDocumentEpisode({ binding, document, now }) {
  const chunks = chunkText(document.content);
  const itemDigest = shortHash(document.id);
  const targetScopeId = binding.targetId ?? binding.id;
  const referenceTime = document.updatedAt ?? now.toISOString();
  return {
    targetKind: 'personal',
    spaceId: binding.target.personalSpaceId,
    personalProjectId: binding.target.personalProjectId,
    idempotencyKey: `external:${targetScopeId}:${itemDigest}:${externalDocumentHash(document)}`,
    sessionId: `external:${targetScopeId}`,
    name: document.title,
    sourceKind: 'document',
    sourceDescription: `Read-only ${binding.connectorType} knowledge source`,
    sourceUri: document.url,
    // The graph contract keeps source_application to a stable agent enum. The
    // connector identity stays in sourceDescription and entity attributes.
    sourceApplication: 'other',
    sourceTurnId: document.id,
    sourceExcerpt: document.content.slice(0, MAX_EXCERPT_LENGTH),
    referenceTime,
    summary: `Imported from the read-only binding “${binding.name}”.`,
    sensitivity: 'restricted',
    entities: chunks.map((content, index) => ({
      key: `external:${targetScopeId}:${itemDigest}:${index + 1}`,
      name: chunks.length === 1 ? document.title : `${document.title} (${index + 1}/${chunks.length})`,
      type: 'ExternalKnowledgeDocument',
      summary: content,
      originQuadrant: 'known_known',
      currentQuadrant: 'known_known',
      epistemicStatus: 'observed',
      confirmationStatus: 'pending',
      confirmationBasis: {
        existenceReason: 'A configured read-only connector returned this source document.',
        quadrantReason: 'The source text is explicit, but FULI has not independently verified it.',
        proposedBy: { kind: 'import', label: binding.connectorType }
      },
      inheritanceMode: 'local_only',
      attributes: {
        externalBindingId: binding.id,
        externalBindingTargetId: targetScopeId,
        externalConnectorType: binding.connectorType,
        externalItemId: document.id,
        externalItemUrl: document.url,
        externalUpdatedAt: document.updatedAt,
        externalChunk: index + 1,
        externalChunkCount: chunks.length,
        externalMetadata: document.metadata
      }
    })),
    relationships: []
  };
}

export function chunkText(content, maximum = MAX_CHUNK_LENGTH) {
  if (content.length <= maximum) return [content];
  const chunks = [];
  let offset = 0;
  while (offset < content.length) {
    const end = Math.min(offset + maximum, content.length);
    let split = end;
    if (end < content.length) {
      const candidate = Math.max(
        content.lastIndexOf('\n\n', end),
        content.lastIndexOf('\n', end),
        content.lastIndexOf(' ', end)
      );
      if (candidate > offset + Math.floor(maximum / 2)) split = candidate;
    }
    chunks.push(content.slice(offset, split).trim());
    offset = split;
    while (/\s/u.test(content[offset] ?? '')) offset += 1;
  }
  return chunks.filter(Boolean);
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function requiredString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${label} is too long`);
  return normalized;
}

function optionalOnlineUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('Connector item URL must be an HTTP(S) URL without credentials');
  }
  return url.toString();
}

function optionalDateTime(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function plainJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`${label} must contain JSON-compatible values`);
  }
}
