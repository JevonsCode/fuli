import { createHash, randomUUID } from 'node:crypto';

import { detectSensitiveContent } from '../security/sensitive-content.js';

import {
  externalDocumentEpisode,
  externalDocumentHash,
  externalDocumentStateKey,
  normalizeExternalDocument
} from './document-mapping.js';
import { safeExternalSourceDiagnostic } from './safe-diagnostic.js';

const MODES = new Set(['hybrid', 'live', 'mirror']);
const MAX_TARGETS = 32;
const CREDENTIAL_FIELDS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'apikey',
  'secret',
  'clientsecret',
  'appsecret',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'privatekey',
  'signingkey',
  'clientkey'
]);

export class ExternalKnowledgeService {
  constructor({
    app,
    registry,
    connectors,
    env = process.env,
    now = () => new Date(),
    createId = randomUUID
  }) {
    if (!app || !registry || !connectors) {
      throw new TypeError('External knowledge service requires app, registry, and connectors');
    }
    this.app = app;
    this.registry = registry;
    this.connectors = connectors;
    this.env = env;
    this.now = now;
    this.createId = createId;
    this.syncs = new Map();
  }

  listConnectorTypes() {
    return this.connectors.list?.() ?? [];
  }

  async listBindings() {
    return this.registry.list().map(publicBinding);
  }

  async discover(input) {
    const connectorType = requiredString(input?.connectorType, 'connectorType', 64);
    const connector = this.#connector(connectorType);
    if (typeof connector.discover !== 'function') {
      throw new TypeError(`${connectorType} does not support discovery`);
    }
    return connector.discover({
      ...this.#context({
        connectorConfig: safeConfiguration(input.connectorConfig ?? {}),
        source: safeConfiguration(input.source ?? {})
      }),
      query: typeof input.query === 'string' ? input.query : null,
      cursor: typeof input.cursor === 'string' ? input.cursor : null,
      limit: positiveInteger(input.limit ?? 50, 'limit', 100)
    });
  }

  async createBinding(input) {
    const connectorType = requiredString(input?.connectorType, 'connectorType', 64);
    const connector = this.#connector(connectorType);
    const connectorConfig = safeConfiguration(input.connectorConfig ?? {});
    const source = safeConfiguration(input.source ?? {});
    const id = this.createId();
    const targets = bindingTargets(input, { bindingId: id });
    assertConnectorMethods(connectorType, connector, targets);
    await this.#assertPersonalProjects(targets);
    const checked = typeof connector.check === 'function'
      ? await connector.check(this.#context({
          id,
          connectorConfig,
          source,
          targets
        }))
      : { status: 'ready' };
    if (checked?.status && checked.status !== 'ready') {
      throw new Error(checked.message ?? `${connectorType} connection is not ready`);
    }
    assertNegotiatedCapabilities(connectorType, checked?.capabilities, targets);
    const timestamp = this.now().toISOString();
    const binding = {
      id,
      name: requiredString(input.name, 'name', 120),
      connectorType,
      connectorConfig,
      source,
      targets,
      status: 'ready',
      capabilities: checked?.capabilities ?? connector.capabilities ?? [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return publicBinding(this.registry.put(binding));
  }

  async updateBindingTargets(id, input) {
    const binding = this.#binding(id);
    const connector = this.#connector(binding.connectorType);
    const targets = bindingTargets(input, {
      bindingId: binding.id,
      existingTargets: binding.targets,
      defaultMode: commonBindingMode(binding.targets)
    });
    assertConnectorMethods(binding.connectorType, connector, targets);
    await this.#assertPersonalProjects(targets);
    const checked = typeof connector.check === 'function'
      ? await connector.check(this.#context({ ...binding, targets }))
      : { status: binding.status, capabilities: binding.capabilities };
    if (checked?.status && checked.status !== 'ready') {
      throw new Error(checked.message ?? `${binding.connectorType} connection is not ready`);
    }
    const capabilities = checked?.capabilities ?? binding.capabilities;
    assertNegotiatedCapabilities(binding.connectorType, capabilities, targets);

    const nextByKey = new Map(targets.map((target) => [targetKey(target), target]));
    for (const previous of binding.targets) {
      const next = nextByKey.get(targetKey(previous));
      if (!next || (previous.mode !== 'live' && next.mode === 'live')) {
        await this.#invalidateTarget(previous);
        if (next) next.sync = emptySyncState();
      }
    }
    binding.targets = targets;
    binding.status = checked?.status ?? binding.status;
    binding.capabilities = capabilities ?? [];
    binding.updatedAt = this.now().toISOString();
    return publicBinding(this.registry.put(binding));
  }

  async checkBinding(id) {
    const binding = this.#binding(id);
    const connector = this.#connector(binding.connectorType);
    const result = typeof connector.check === 'function'
      ? await connector.check(this.#context(binding))
      : { status: 'ready', capabilities: connector.capabilities ?? [] };
    assertNegotiatedCapabilities(binding.connectorType, result.capabilities, binding.targets);
    binding.status = result.status ?? 'ready';
    binding.capabilities = result.capabilities ?? binding.capabilities;
    binding.updatedAt = this.now().toISOString();
    this.registry.put(binding);
    return { bindingId: binding.id, ...result };
  }

  async syncBinding(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Synchronization options must be an object');
    }
    const maxPages = positiveInteger(options.maxPages ?? 100, 'maxPages', 100);
    const pageSize = positiveInteger(options.pageSize ?? 100, 'pageSize', 100);
    const binding = this.#binding(id);
    const targets = selectedTargets(binding, options, { capability: 'sync' });
    const results = [];
    for (const target of targets) {
      const syncKey = `${id}:${target.id}`;
      const pending = this.syncs.get(syncKey) ?? this.#sync(binding, target, {
        maxPages,
        pageSize
      }).finally(() => this.syncs.delete(syncKey));
      this.syncs.set(syncKey, pending);
      results.push(await pending);
    }
    return aggregateSyncResults(id, results);
  }

  async retrieveBinding(id, input = {}) {
    const { query, limit = 12 } = input;
    const binding = this.#binding(id);
    const target = selectedTargets(binding, input, {
      capability: 'retrieve',
      requireOne: true
    })[0];
    if (target.mode === 'mirror') {
      throw new TypeError('This binding is configured for synchronized graph search only');
    }
    const connector = this.#connector(binding.connectorType);
    if (typeof connector.retrieve !== 'function') {
      throw new TypeError(`${binding.connectorType} does not support live retrieval`);
    }
    const normalizedQuery = requiredString(query, 'query', 2_000);
    const resolvedLimit = positiveInteger(limit, 'limit', 100);
    const result = await connector.retrieve({
      ...this.#context(binding, target),
      query: normalizedQuery,
      limit: resolvedLimit
    });
    const items = [];
    let skippedCredentials = 0;
    for (const value of (result?.items ?? result?.hits ?? []).slice(0, resolvedLimit)) {
      try {
        items.push(normalizeExternalDocument(value));
      } catch (error) {
        if (!isCredentialDocumentError(error)) throw error;
        skippedCredentials += 1;
      }
    }
    return {
      bindingId: id,
      targetId: target.id,
      personalProjectId: target.personalProjectId,
      query: normalizedQuery,
      items,
      skippedCredentials
    };
  }

  async deleteBinding(id) {
    const binding = this.#binding(id);
    let invalidated = 0;
    for (const target of binding.targets) {
      invalidated += await this.#invalidateTarget(target);
    }
    this.registry.delete(id);
    return { bindingId: id, status: 'deleted', invalidated };
  }

  projectGraphProjection({ personalSpaceId, personalProjectId = null, graph }) {
    const projectNodes = new Map(
      (graph?.nodes ?? [])
        .filter((node) => node?.type === 'PersonalProject')
        .map((node) => [node?.attributes?.projectId, node])
        .filter(([projectId]) => typeof projectId === 'string' && projectId)
    );
    const nodes = [];
    const edges = [];
    const projectedBindings = new Set();

    for (const binding of this.registry.list()) {
      const targets = binding.targets.filter((target) =>
        target.personalSpaceId === personalSpaceId &&
        (!personalProjectId || target.personalProjectId === personalProjectId) &&
        projectNodes.has(target.personalProjectId)
      );
      if (!targets.length) continue;

      const sourceId = `external-knowledge-source:${binding.id}`;
      if (!projectedBindings.has(binding.id)) {
        projectedBindings.add(binding.id);
        const groupId = projectNodes.get(targets[0].personalProjectId)?.group_id;
        nodes.push({
          id: sourceId,
          name: binding.name,
          type: 'ExternalKnowledgeSource',
          summary: `Read-only ${binding.connectorType} knowledge source.`,
          ...(groupId ? { group_id: groupId } : {}),
          origin_quadrant: 'known_known',
          current_quadrant: 'known_known',
          epistemic_status: 'observed',
          confirmation_status: 'confirmed',
          confirmation_basis: {
            existence_reason: 'This external knowledge connection is configured in FULI.',
            quadrant_reason: 'The connection and its project assignments are explicit configuration.',
            proposed_by: { kind: 'import', label: binding.connectorType },
            confirmed_by: { kind: 'user', label: 'connection configuration' },
            confirmed_at: binding.updatedAt ?? binding.createdAt ?? null
          },
          attributes: {
            externalBindingId: binding.id,
            externalConnectorType: binding.connectorType,
            externalBindingStatus: binding.status,
            externalCapabilities: binding.capabilities ?? [],
            externalTargetCount: binding.targets.length,
            externalModes: [...new Set(binding.targets.map(({ mode }) => mode))]
          }
        });
      }

      for (const target of targets) {
        const projectNode = projectNodes.get(target.personalProjectId);
        edges.push({
          id: `external-knowledge-binding:${binding.id}:${target.id}`,
          source: projectNode.id,
          target: sourceId,
          source_name: projectNode.name,
          target_name: binding.name,
          type: 'USES_EXTERNAL_KNOWLEDGE',
          fact: `${projectNode.name} uses the read-only external knowledge source ${binding.name}.`,
          origin_quadrant: 'known_known',
          current_quadrant: 'known_known',
          epistemic_status: 'observed',
          confirmation_status: 'confirmed',
          attributes: {
            externalBindingId: binding.id,
            externalBindingTargetId: target.id,
            mode: target.mode,
            status: target.status,
            lastSyncedAt: target.sync?.lastSyncedAt ?? null
          }
        });
      }
    }
    return { nodes, edges };
  }

  async #sync(binding, target, { maxPages, pageSize }) {
    if (target.mode === 'live') {
      throw new TypeError('This binding is configured for live retrieval only');
    }
    const connector = this.#connector(binding.connectorType);
    let cursor = target.sync.cursor;
    let imported = 0;
    let unchanged = 0;
    let invalidated = 0;
    let skippedCredentials = 0;
    let hasMore = false;
    try {
      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const page = connectorSyncPage(await connector.sync({
          ...this.#context(binding, target),
          cursor,
          limit: pageSize
        }), pageSize);
        const { items, deleted } = page;
        for (const value of items) {
          let document;
          try {
            document = normalizeExternalDocument(value);
          } catch (error) {
            if (!isCredentialDocumentError(error)) throw error;
            skippedCredentials += 1;
            const rejectedId = connectorItemId(value);
            if (rejectedId) {
              const rejectedKey = externalDocumentStateKey(rejectedId);
              const previous = target.sync.items[rejectedKey];
              if (previous) {
                invalidated += await this.#invalidateEntities(
                  previous.entityIds ?? [],
                  target
                );
                delete target.sync.items[rejectedKey];
              }
            }
            continue;
          }
          const hash = externalDocumentHash(document);
          const itemKey = externalDocumentStateKey(document.id);
          const previous = target.sync.items[itemKey];
          if (previous?.hash === hash) {
            unchanged += 1;
            continue;
          }
          const capture = await this.app.captureSessionKnowledge(externalDocumentEpisode({
            binding: bindingForTarget(binding, target),
            document,
            now: this.now()
          }));
          if (capture?.status === 'capture_disabled') {
            throw new Error('FULI knowledge capture is disabled');
          }
          invalidated += await this.#invalidateEntities(
            previous?.entityIds ?? [],
            target
          );
          target.sync.items[itemKey] = {
            externalId: document.id,
            hash,
            entityIds: capture?.entity_ids ?? capture?.entityIds ?? [],
            updatedAt: document.updatedAt,
            url: document.url
          };
          imported += 1;
        }
        for (const value of deleted) {
          const deletedId = connectorItemId(value);
          if (!deletedId) continue;
          const itemKey = externalDocumentStateKey(deletedId);
          if (!target.sync.items[itemKey]) continue;
          invalidated += await this.#invalidateEntities(
            target.sync.items[itemKey].entityIds ?? [],
            target
          );
          delete target.sync.items[itemKey];
        }
        hasMore = page?.hasMore === true;
        const nextCursor = page?.nextCursor ?? null;
        if (hasMore && (!nextCursor || nextCursor === cursor)) {
          throw new TypeError('Connector returned an invalid pagination cursor');
        }
        cursor = nextCursor;
        if (!hasMore) break;
        if (pageNumber === maxPages - 1) {
          throw new Error(`Synchronization exceeded ${maxPages} pages`);
        }
      }
      target.status = 'ready';
      binding.updatedAt = this.now().toISOString();
      target.sync.cursor = cursor;
      target.sync.lastSyncedAt = binding.updatedAt;
      target.sync.error = null;
      target.sync.skippedCredentials = skippedCredentials;
      this.registry.put(binding);
      return {
        bindingId: binding.id,
        targetId: target.id,
        personalProjectId: target.personalProjectId,
        status: 'ready',
        imported,
        unchanged,
        invalidated,
        skippedCredentials,
        nextCursor: cursor,
        hasMore
      };
    } catch (error) {
      target.status = 'error';
      binding.updatedAt = this.now().toISOString();
      target.sync.error = safeExternalSourceDiagnostic(error);
      this.registry.put(binding);
      throw error;
    }
  }

  async #invalidateTarget(target) {
    let invalidated = 0;
    for (const item of Object.values(target.sync?.items ?? {})) {
      invalidated += await this.#invalidateEntities(item.entityIds ?? [], target);
    }
    return invalidated;
  }

  async #invalidateEntities(ids, target) {
    if (!ids.length) return 0;
    if (typeof this.app.reviseKnowledgeItem !== 'function') {
      throw new Error('FULI application cannot invalidate replaced external knowledge');
    }
    for (const itemId of ids) {
      await this.app.reviseKnowledgeItem({
        personalSpaceId: target.personalSpaceId,
        personalProjectId: target.personalProjectId,
        itemKind: 'entity',
        itemId,
        action: 'invalidate',
        reason: 'The read-only external source was changed, removed, or disconnected.',
        operationActor: 'agent'
      });
    }
    return ids.length;
  }

  async #assertPersonalProjects(targets) {
    const bySpace = new Map();
    for (const target of targets) {
      const selected = bySpace.get(target.personalSpaceId) ?? [];
      selected.push(target);
      bySpace.set(target.personalSpaceId, selected);
    }
    for (const [personalSpaceId, selected] of bySpace) {
      const projects = await this.app.listPersonalProjects({ personalSpaceId });
      const available = new Set(projects.map(({ project_id: id, id: fallback }) => id ?? fallback));
      if (selected.some(({ personalProjectId }) => !available.has(personalProjectId))) {
        throw new TypeError('External knowledge target must be an existing personal project');
      }
    }
  }

  #binding(id) {
    const binding = this.registry.get(requiredString(id, 'binding id', 128));
    if (!binding) throw new TypeError('External knowledge binding was not found');
    return binding;
  }

  #connector(type) {
    const connector = this.connectors.get(type);
    if (!connector) throw new TypeError(`Unknown external knowledge connector: ${type}`);
    return connector;
  }

  #context(binding, target = null) {
    return {
      config: binding.connectorConfig,
      source: binding.source,
      env: this.env,
      bindingId: binding.id ?? null,
      mode: target?.mode ?? commonBindingMode(binding.targets ?? [])
    };
  }
}

function publicBinding(binding) {
  const output = structuredClone(binding);
  const first = output.targets?.[0] ?? null;
  return {
    ...output,
    // Keep the v1 aliases while clients migrate to target-aware bindings.
    target: first ? {
      personalSpaceId: first.personalSpaceId,
      personalProjectId: first.personalProjectId
    } : null,
    mode: first?.mode ?? null,
    sync: first?.sync ?? null
  };
}

function bindingTargets(input, {
  bindingId,
  existingTargets = [],
  defaultMode = 'hybrid'
}) {
  const values = Array.isArray(input?.targets)
    ? input.targets
    : input?.target
      ? [{ ...input.target, mode: input.mode ?? defaultMode }]
      : null;
  if (!values || !values.length) {
    throw new TypeError('At least one target personal project is required');
  }
  if (values.length > MAX_TARGETS) {
    throw new TypeError(`A connection can target at most ${MAX_TARGETS} personal projects`);
  }

  const existingByKey = new Map(existingTargets.map((target) => [targetKey(target), target]));
  const reservedIds = new Set(existingTargets.map(({ id }) => id));
  const seen = new Set();
  return values.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`targets[${index}] must be an object`);
    }
    const target = {
      personalSpaceId: requiredString(
        value.personalSpaceId,
        `targets[${index}].personalSpaceId`,
        256
      ),
      personalProjectId: requiredString(
        value.personalProjectId,
        `targets[${index}].personalProjectId`,
        256
      )
    };
    const key = targetKey(target);
    if (seen.has(key)) throw new TypeError('Target personal projects must be unique');
    seen.add(key);
    const previous = existingByKey.get(key);
    const mode = requiredString(
      value.mode ?? previous?.mode ?? defaultMode,
      `targets[${index}].mode`,
      16
    );
    if (!MODES.has(mode)) throw new TypeError('mode must be hybrid, live, or mirror');
    const id = previous?.id ?? targetId(bindingId, target, {
      preferBindingId: existingTargets.length === 0 && index === 0,
      reservedIds
    });
    reservedIds.add(id);
    return {
      id,
      ...target,
      mode,
      status: previous?.status ?? 'ready',
      sync: structuredClone(previous?.sync ?? emptySyncState())
    };
  });
}

function targetId(bindingId, target, { preferBindingId, reservedIds }) {
  if (preferBindingId && !reservedIds.has(bindingId)) return bindingId;
  const digest = createHash('sha256')
    .update(`${bindingId}\0${target.personalSpaceId}\0${target.personalProjectId}`)
    .digest('hex')
    .slice(0, 24);
  const id = `target:${digest}`;
  if (reservedIds.has(id)) {
    throw new TypeError('Target identifier collision');
  }
  return id;
}

function targetKey(target) {
  return `${target.personalSpaceId}\0${target.personalProjectId}`;
}

function emptySyncState() {
  return {
    cursor: null,
    lastSyncedAt: null,
    error: null,
    skippedCredentials: 0,
    items: {}
  };
}

function commonBindingMode(targets) {
  const modes = new Set((targets ?? []).map(({ mode }) => mode));
  if (modes.size === 1) return [...modes][0];
  const requiresSync = [...modes].some((mode) => mode !== 'live');
  const requiresRetrieve = [...modes].some((mode) => mode !== 'mirror');
  if (requiresSync && requiresRetrieve) return 'hybrid';
  if (requiresSync) return 'mirror';
  return 'live';
}

function assertConnectorMethods(type, connector, targets) {
  if (targets.some(({ mode }) => mode !== 'live') && typeof connector.sync !== 'function') {
    throw new TypeError(`${type} does not support synchronization`);
  }
  if (targets.some(({ mode }) => mode !== 'mirror') && typeof connector.retrieve !== 'function') {
    throw new TypeError(`${type} does not support live retrieval`);
  }
}

function assertNegotiatedCapabilities(type, capabilities, targets) {
  if (!Array.isArray(capabilities) || !capabilities.length) return;
  if (targets.some(({ mode }) => mode !== 'live') && !capabilities.includes('sync')) {
    throw new TypeError(`${type} does not advertise synchronization capability`);
  }
  if (targets.some(({ mode }) => mode !== 'mirror') && !capabilities.includes('retrieve')) {
    throw new TypeError(`${type} does not advertise live retrieval capability`);
  }
}

function selectedTargets(binding, input, { capability, requireOne = false }) {
  const personalSpaceId = optionalString(input?.personalSpaceId, 'personalSpaceId', 256);
  const personalProjectId = optionalString(input?.personalProjectId, 'personalProjectId', 256);
  let targets = binding.targets.filter((target) =>
    (!personalSpaceId || target.personalSpaceId === personalSpaceId) &&
    (!personalProjectId || target.personalProjectId === personalProjectId)
  );
  if ((personalSpaceId || personalProjectId) && !targets.length) {
    throw new TypeError('External knowledge binding is not assigned to this personal project');
  }
  targets = targets.filter(({ mode }) => capability === 'sync' ? mode !== 'live' : mode !== 'mirror');
  if (!targets.length) {
    throw new TypeError(capability === 'sync'
      ? 'This binding is configured for live retrieval only'
      : 'This binding is configured for synchronized graph search only');
  }
  if (requireOne && targets.length !== 1) {
    throw new TypeError('personalSpaceId and personalProjectId are required for a multi-project binding');
  }
  return targets;
}

function aggregateSyncResults(bindingId, results) {
  if (results.length === 1) {
    const { targetId: _targetId, personalProjectId: _projectId, ...result } = results[0];
    return result;
  }
  return {
    bindingId,
    status: results.every(({ status }) => status === 'ready') ? 'ready' : 'partial',
    imported: sum(results, 'imported'),
    unchanged: sum(results, 'unchanged'),
    invalidated: sum(results, 'invalidated'),
    skippedCredentials: sum(results, 'skippedCredentials'),
    nextCursor: null,
    hasMore: results.some(({ hasMore }) => hasMore),
    targets: results
  };
}

function sum(values, field) {
  return values.reduce((total, value) => total + (value[field] ?? 0), 0);
}

function bindingForTarget(binding, target) {
  return {
    ...binding,
    targetId: target.id,
    target: {
      personalSpaceId: target.personalSpaceId,
      personalProjectId: target.personalProjectId
    },
    mode: target.mode,
    sync: target.sync
  };
}

function safeConfiguration(value, path = 'configuration') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const output = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (credentialField(key) && !credentialReferenceField(key)) {
      throw new TypeError(`${path}.${key} cannot contain credentials; use an environment variable name`);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      output[key] = item;
    } else if (typeof item === 'string') {
      assertSafeConfigurationString(item, `${path}.${key}`);
      output[key] = item;
    } else if (Array.isArray(item)) {
      output[key] = item.map((entry, index) =>
        entry && typeof entry === 'object'
          ? safeConfiguration(entry, `${path}.${key}[${index}]`)
          : entry
      );
    } else if (item && typeof item === 'object') {
      output[key] = safeConfiguration(item, `${path}.${key}`);
    } else {
      throw new TypeError(`${path}.${key} must be JSON-compatible`);
    }
  }
  if (detectSensitiveContent(JSON.stringify(output)).restricted) {
    throw new TypeError(`${path} cannot contain credentials; use an environment variable name`);
  }
  return output;
}

function assertSafeConfigurationString(value, path) {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return;
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new TypeError(`${path} cannot contain credentials; use an environment variable name`);
    }
  } catch (error) {
    if (error instanceof TypeError && /cannot contain credentials/u.test(error.message)) {
      throw error;
    }
  }
}

function credentialField(key) {
  const normalized = normalizedConfigurationKey(key);
  const withoutReferenceSuffix = normalized.replace(/(?:environment|env|names|name)$/u, '');
  return CREDENTIAL_FIELDS.has(normalized) || CREDENTIAL_FIELDS.has(withoutReferenceSuffix);
}

function credentialReferenceField(key) {
  return /(?:environment|env|names|name)$/u.test(normalizedConfigurationKey(key));
}

function normalizedConfigurationKey(key) {
  return key.toLocaleLowerCase().replace(/[^a-z0-9]/gu, '');
}

function requiredString(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${label} is too long`);
  return normalized;
}

function optionalString(value, label, maximum) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, label, maximum);
}

function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function isCredentialDocumentError(error) {
  return error instanceof TypeError &&
    error.message === 'Connector item contains credentials and cannot be retrieved or stored';
}

function connectorItemId(value) {
  const id = typeof value === 'string' ? value : value?.id;
  if (typeof id !== 'string') return null;
  const normalized = id.trim();
  return normalized && normalized.length <= 512 ? normalized : null;
}

function connectorSyncPage(value, pageSize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Connector synchronization result must be an object');
  }
  const items = value.items ?? [];
  const deleted = value.deleted ?? [];
  if (!Array.isArray(items) || !Array.isArray(deleted)) {
    throw new TypeError('Connector synchronization items and deleted must be arrays');
  }
  if (items.length > pageSize) {
    throw new TypeError(`Connector returned more than ${pageSize} items`);
  }
  if (deleted.length > pageSize) {
    throw new TypeError(`Connector returned more than ${pageSize} deletions`);
  }
  if (value.hasMore !== undefined && typeof value.hasMore !== 'boolean') {
    throw new TypeError('Connector hasMore must be a boolean');
  }
  const nextCursor = value.nextCursor ?? null;
  if (nextCursor !== null &&
      (typeof nextCursor !== 'string' || nextCursor.length > 64_000)) {
    throw new TypeError('Connector nextCursor must be a string no longer than 64000 characters');
  }
  return {
    ...value,
    items,
    deleted,
    hasMore: value.hasMore === true,
    nextCursor
  };
}
