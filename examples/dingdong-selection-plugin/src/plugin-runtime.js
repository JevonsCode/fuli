import { redactProviderConfig, validateProviderConfig } from './provider-router.js';

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'id',
  'displayName',
  'version',
  'entry',
  'capabilities',
  'commands'
]);

const COMMAND_KEYS = new Set(['id', 'label', 'permissions']);
const KNOWN_CAPABILITIES = new Set([
  'selection.read',
  'clipboard.write',
  'host.permissions',
  'model.provider',
  'text.translate',
  'text.explain'
]);

export class PluginContractError extends Error {
  constructor(message, code = 'PLUGIN_CONTRACT_ERROR') {
    super(message);
    this.name = 'PluginContractError';
    this.code = code;
  }
}

export class PluginPermissionError extends Error {
  constructor(permission) {
    super(`Plugin command does not have permission: ${permission}`);
    this.name = 'PluginPermissionError';
    this.code = 'PLUGIN_PERMISSION_DENIED';
    this.permission = permission;
  }
}

export class PluginDisabledError extends Error {
  constructor(pluginId) {
    super(`Plugin is disabled: ${pluginId}`);
    this.name = 'PluginDisabledError';
    this.code = 'PLUGIN_DISABLED';
    this.pluginId = pluginId;
  }
}

export function validatePluginManifest(value) {
  assertPlainObject(value, 'Plugin manifest');
  rejectUnknownKeys(value, MANIFEST_KEYS, 'Plugin manifest');
  if (value.schemaVersion !== 1) {
    throw new PluginContractError('Plugin manifest schemaVersion must be 1');
  }
  assertSafeId(value.id, 'Plugin id');
  assertNonEmptyString(value.displayName, 'Plugin displayName');
  assertVersion(value.version);
  assertRelativeEntry(value.entry);

  const capabilities = uniqueStrings(value.capabilities, 'Plugin capabilities');
  for (const capability of capabilities) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new PluginContractError(`Unknown plugin capability: ${capability}`);
    }
  }

  if (!Array.isArray(value.commands) || value.commands.length === 0) {
    throw new PluginContractError('Plugin commands must be a non-empty array');
  }
  const commandIds = new Set();
  const commands = value.commands.map((command, index) => {
    assertPlainObject(command, `Plugin command ${index}`);
    rejectUnknownKeys(command, COMMAND_KEYS, `Plugin command ${index}`);
    assertSafeId(command.id, `Plugin command ${index} id`);
    if (commandIds.has(command.id)) {
      throw new PluginContractError(`Duplicate plugin command id: ${command.id}`);
    }
    commandIds.add(command.id);
    assertNonEmptyString(command.label, `Plugin command ${command.id} label`);
    const permissions = uniqueStrings(
      command.permissions,
      `Plugin command ${command.id} permissions`
    );
    if (permissions.length === 0) {
      throw new PluginContractError(`Plugin command ${command.id} needs permissions`);
    }
    for (const permission of permissions) {
      if (!capabilities.includes(permission)) {
        throw new PluginContractError(
          `Plugin command ${command.id} uses undeclared capability: ${permission}`
        );
      }
    }
    return Object.freeze({
      id: command.id,
      label: command.label,
      permissions: Object.freeze(permissions)
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    id: value.id,
    displayName: value.displayName,
    version: value.version,
    entry: value.entry,
    capabilities: Object.freeze(capabilities),
    commands: Object.freeze(commands)
  });
}

export function createPluginRuntime({ ports = {}, onEvent = () => {}, enabled = true } = {}) {
  if (typeof enabled !== 'boolean') {
    throw new PluginContractError('Plugin runtime enabled state must be a boolean');
  }
  const registrations = new Map();

  const runtime = Object.freeze({
    register(manifestInput, createPlugin, options = {}) {
      const manifest = validatePluginManifest(manifestInput);
      if (registrations.has(manifest.id)) {
        throw new PluginContractError(
          `Plugin is already registered: ${manifest.id}`,
          'PLUGIN_DUPLICATE'
        );
      }
      if (typeof createPlugin !== 'function') {
        throw new PluginContractError('Plugin factory must be a function');
      }
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new PluginContractError('Plugin registration options must be an object');
      }
      const registrationEnabled = options.enabled ?? options.userEnabled ?? enabled;
      if (typeof registrationEnabled !== 'boolean') {
        throw new PluginContractError('Plugin enabled state must be a boolean');
      }
      const plugin = createPlugin();
      assertPlugin(plugin, manifest);
      registrations.set(manifest.id, {
        manifest,
        plugin,
        enabled: registrationEnabled,
        state: registrationEnabled ? 'registered' : 'disabled'
      });
      emit(onEvent, manifest.id, 'registered');
      return manifest;
    },

    async start(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      if (!registration.enabled) throw new PluginDisabledError(pluginId);
      if (registration.state === 'active') return;
      await registration.plugin.activate?.();
      registration.state = 'active';
      emit(onEvent, pluginId, 'active');
    },

    async stop(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      if (registration.state !== 'active') return;
      await registration.plugin.deactivate?.();
      registration.state = registration.enabled ? 'stopped' : 'disabled';
      emit(onEvent, pluginId, 'stopped');
    },

    async enable(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      registration.enabled = true;
      emit(onEvent, pluginId, 'enabled');
      if (registration.state !== 'active') {
        await registration.plugin.activate?.();
        registration.state = 'active';
        emit(onEvent, pluginId, 'active');
      }
    },

    async disable(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      registration.enabled = false;
      if (registration.state === 'active') {
        try {
          await registration.plugin.deactivate?.();
        } finally {
          registration.state = 'disabled';
        }
      } else {
        registration.state = 'disabled';
      }
      emit(onEvent, pluginId, 'disabled');
    },

    setEnabled(pluginId, value) {
      if (typeof value !== 'boolean') {
        throw new PluginContractError('Plugin enabled state must be a boolean');
      }
      return value
        ? runtime.enable(pluginId)
        : runtime.disable(pluginId);
    },

    async unregister(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      if (registration.state === 'active') {
        throw new PluginContractError(
          `Stop plugin before unregistering: ${pluginId}`,
          'PLUGIN_ACTIVE'
        );
      }
      await registration.plugin.dispose?.();
      registrations.delete(pluginId);
      emit(onEvent, pluginId, 'unregistered');
    },

    async execute(pluginId, commandId, input = {}, { signal } = {}) {
      const registration = requireRegistration(registrations, pluginId);
      if (!registration.enabled) throw new PluginDisabledError(pluginId);
      if (registration.state !== 'active') {
        throw new PluginContractError(
          `Plugin is not active: ${pluginId}`,
          'PLUGIN_NOT_ACTIVE'
        );
      }
      const command = registration.manifest.commands.find(
        (candidate) => candidate.id === commandId
      );
      if (!command) {
        throw new PluginContractError(
          `Plugin command is not declared: ${commandId}`,
          'PLUGIN_COMMAND_UNKNOWN'
        );
      }
      const handler = registration.plugin.commands[commandId];
      const host = createCommandHost(
        command.permissions,
        ports,
        () => registration.enabled,
        { pluginId, capabilities: registration.manifest.capabilities }
      );
      emit(onEvent, pluginId, 'command.started', { commandId });
      try {
        const result = await handler({ input, host, signal });
        emit(onEvent, pluginId, 'command.completed', { commandId });
        return result;
      } catch (error) {
        emit(onEvent, pluginId, 'command.failed', {
          commandId,
          code: error?.code ?? 'PLUGIN_COMMAND_FAILED'
        });
        throw error;
      }
    },

    state(pluginId) {
      return requireRegistration(registrations, pluginId).state;
    },

    isEnabled(pluginId) {
      return requireRegistration(registrations, pluginId).enabled;
    },

    status(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      return Object.freeze({
        pluginId,
        enabled: registration.enabled,
        state: registration.state
      });
    },

    async permissionStatus(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      if (!registration.enabled) {
        return Object.freeze({
          pluginId,
          enabled: false,
          state: 'disabled'
        });
      }
      if (!registration.manifest.capabilities.includes('host.permissions')) {
        throw new PluginContractError(
          'Plugin does not declare host.permissions',
          'PLUGIN_CAPABILITY_UNDECLARED'
        );
      }
      const port = ports.permissions ?? ports.permissionProxy ?? ports.hostPermissions;
      const method = port?.getStatus ?? port?.status ?? port?.query;
      if (typeof method !== 'function') {
        throw new PluginContractError(
          'Host capability is unavailable: host.permissions',
          'HOST_CAPABILITY_UNAVAILABLE'
        );
      }
      return method.call(port, {
        pluginId,
        capabilities: registration.manifest.capabilities
      });
    },

    async getPermissionStatus(pluginId) {
      return runtime.permissionStatus(pluginId);
    },

    async permissions(pluginId) {
      return runtime.permissionStatus(pluginId);
    },

    getProviderConfig(pluginId) {
      const registration = requireRegistration(registrations, pluginId);
      if (!registration.enabled) return null;
      requireDeclaredCapability(registration, 'model.provider');
      const port = ports.modelProvider ?? ports.provider ?? ports.textService;
      const method = port?.getConfig ?? port?.config;
      if (typeof method !== 'function') {
        throw new PluginContractError(
          'Host capability is unavailable: model.provider',
          'HOST_CAPABILITY_UNAVAILABLE'
        );
      }
      const value = method.call(port);
      if (value && typeof value.then === 'function') {
        return value.then((config) => config ? redactProviderConfig(config) : null);
      }
      return value ? redactProviderConfig(value) : null;
    },

    async setProviderConfig(pluginId, config) {
      const registration = requireRegistration(registrations, pluginId);
      if (!registration.enabled) throw new PluginDisabledError(pluginId);
      requireDeclaredCapability(registration, 'model.provider');
      const safeConfig = validateProviderConfig(config);
      const port = ports.modelProvider ?? ports.provider ?? ports.textService;
      const method = port?.setConfig ?? port?.configure;
      if (typeof method !== 'function') {
        throw new PluginContractError(
          'Host capability is unavailable: model.provider',
          'HOST_CAPABILITY_UNAVAILABLE'
        );
      }
      const value = await method.call(port, safeConfig);
      return value ? redactProviderConfig(value) : redactProviderConfig(safeConfig);
    },

    providerConfig(pluginId) {
      return runtime.getProviderConfig(pluginId);
    },

    configureProvider(pluginId, config) {
      return runtime.setProviderConfig(pluginId, config);
    }
  });
  return runtime;
}

function createCommandHost(permissions, ports, isEnabled = () => true, context = {}) {
  const allowed = new Set(permissions);
  const requireEnabled = () => {
    if (!isEnabled()) throw new PluginDisabledError(context.pluginId ?? 'unknown');
  };
  const requirePermission = (permission) => {
    requireEnabled();
    if (!allowed.has(permission)) throw new PluginPermissionError(permission);
  };
  return Object.freeze({
    readSelection(value) {
      requirePermission('selection.read');
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new PluginContractError(
          'Select non-empty text before running a command',
          'SELECTION_REQUIRED'
        );
      }
      return value.trim().slice(0, 10_000);
    },
    async writeClipboard(text) {
      requirePermission('clipboard.write');
      requirePortMethod(ports.clipboard, 'writeText', 'clipboard.write');
      await ports.clipboard.writeText(text);
    },
    async translate(request) {
      requirePermission('text.translate');
      requirePermission('model.provider');
      const provider = ports.modelProvider ?? ports.provider ?? ports.textService;
      requirePortMethod(provider, 'translate', 'model.provider');
      return provider.translate(request);
    },
    async explain(request) {
      requirePermission('text.explain');
      requirePermission('model.provider');
      const provider = ports.modelProvider ?? ports.provider ?? ports.textService;
      requirePortMethod(provider, 'explain', 'model.provider');
      return provider.explain(request);
    },
    async getPermissionStatus() {
      requirePermission('host.permissions');
      const port = ports.permissions ?? ports.permissionProxy ?? ports.hostPermissions;
      const method = port?.getStatus ?? port?.status ?? port?.query;
      if (typeof method !== 'function') {
        throw new PluginContractError(
          'Host capability is unavailable: host.permissions',
          'HOST_CAPABILITY_UNAVAILABLE'
        );
      }
      return method.call(port, context);
    },
    async permissionStatus() {
      return this.getPermissionStatus();
    }
  });
}

function requirePortMethod(port, method, permission) {
  if (!port || typeof port[method] !== 'function') {
    throw new PluginContractError(
      `Host capability is unavailable: ${permission}`,
      'HOST_CAPABILITY_UNAVAILABLE'
    );
  }
}

function assertPlugin(plugin, manifest) {
  assertPlainObject(plugin, 'Plugin factory result');
  assertPlainObject(plugin.commands, 'Plugin commands');
  for (const command of manifest.commands) {
    if (typeof plugin.commands[command.id] !== 'function') {
      throw new PluginContractError(
        `Plugin handler is missing for command: ${command.id}`
      );
    }
  }
  for (const hook of ['activate', 'deactivate', 'dispose']) {
    if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') {
      throw new PluginContractError(`Plugin ${hook} hook must be a function`);
    }
  }
}

function requireRegistration(registrations, pluginId) {
  const registration = registrations.get(pluginId);
  if (!registration) {
    throw new PluginContractError(
      `Plugin is not registered: ${pluginId}`,
      'PLUGIN_NOT_REGISTERED'
    );
  }
  return registration;
}

function requireDeclaredCapability(registration, capability) {
  if (!registration.manifest.capabilities.includes(capability)) {
    throw new PluginContractError(
      `Plugin does not declare ${capability}`,
      'PLUGIN_CAPABILITY_UNDECLARED'
    );
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginContractError(`${label} must be an object`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new PluginContractError(`${label} has unknown field: ${unknown[0]}`);
  }
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value)) {
    throw new PluginContractError(`${label} must be a safe lowercase id`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PluginContractError(`${label} must be a non-empty string`);
  }
}

function assertVersion(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new PluginContractError('Plugin version must be semantic x.y.z');
  }
}

function assertRelativeEntry(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith('./') ||
    value.includes('..') ||
    value.includes('\\')
  ) {
    throw new PluginContractError('Plugin entry must be a safe relative path');
  }
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PluginContractError(`${label} must be a string array`);
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) {
    throw new PluginContractError(`${label} must not contain duplicates`);
  }
  return unique;
}

function emit(onEvent, pluginId, type, detail = {}) {
  onEvent(Object.freeze({ pluginId, type, detail, at: new Date().toISOString() }));
}
