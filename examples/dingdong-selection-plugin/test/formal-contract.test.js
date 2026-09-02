import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createPluginRuntime,
  validatePluginManifest
} from '../src/plugin-runtime.js';
import { createSelectionPlugin } from '../src/selection-plugin.js';
import {
  createProviderConfigStore,
  createProviderRouter,
  redactProviderConfig,
  validateProviderConfig
} from '../src/provider-router.js';

const manifest = JSON.parse(
  await readFile(new URL('../plugin.json', import.meta.url), 'utf8')
);

test('manifest declares host permission proxy and model provider capabilities', () => {
  const validated = validatePluginManifest(manifest);
  for (const capability of [
    'selection.read',
    'clipboard.write',
    'host.permissions',
    'model.provider'
  ]) {
    assert.ok(validated.capabilities.includes(capability), capability);
  }
  assert.ok(
    validated.commands.find((command) => command.id === 'translate')
      .permissions.includes('model.provider')
  );
  assert.ok(
    validated.commands.find((command) => command.id === 'explain')
      .permissions.includes('model.provider')
  );
});

test('disabled plugin rejects commands before selection, clipboard, permission, or model ports', async () => {
  const calls = [];
  const runtime = createPluginRuntime({
    ports: {
      clipboard: { writeText: async () => calls.push('clipboard') },
      textService: {
        translate: async () => calls.push('translate'),
        explain: async () => calls.push('explain')
      },
      permissions: { getStatus: async () => calls.push('permissions') }
    }
  });
  runtime.register(manifest, createSelectionPlugin);
  await runtime.start(manifest.id);
  await runtime.disable(manifest.id);

  await assert.rejects(
    runtime.execute(manifest.id, 'copy', { selection: 'secret' }),
    (error) => error.code === 'PLUGIN_DISABLED'
  );
  await assert.rejects(
    runtime.execute(manifest.id, 'translate', { selection: 'secret' }),
    (error) => error.code === 'PLUGIN_DISABLED'
  );
  assert.deepEqual(calls, []);
  assert.equal(runtime.isEnabled(manifest.id), false);

  await runtime.enable(manifest.id);
  await runtime.start(manifest.id);
  assert.equal(runtime.isEnabled(manifest.id), true);
});

test('permission status is exposed through the host permission proxy', async () => {
  const runtime = createPluginRuntime({
    ports: {
      permissions: {
        getStatus: async (request) => ({
          pluginId: request.pluginId,
          selection: 'granted',
          clipboard: 'granted',
          model: 'granted'
        })
      }
    }
  });
  runtime.register(manifest, createSelectionPlugin);
  const status = await runtime.permissionStatus(manifest.id);
  assert.deepEqual(status, {
    pluginId: manifest.id,
    selection: 'granted',
    clipboard: 'granted',
    model: 'granted'
  });
});

test('runtime provider configuration seam exposes only redacted config and is gated by the user switch', async () => {
  const calls = [];
  const provider = {
    setConfig: (config) => {
      calls.push(['set', config]);
      return config;
    },
    getConfig: () => calls.at(-1)?.[1] ?? null
  };
  const runtime = createPluginRuntime({ ports: { modelProvider: provider } });
  runtime.register(manifest, createSelectionPlugin);
  const safe = await runtime.setProviderConfig(manifest.id, {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    model: 'model-x',
    keychainTokenRef: 'keychain://selection/model-x'
  });
  assert.equal(safe.keychainTokenRef, 'keychain://selection/model-x');
  assert.equal(Object.hasOwn(calls[0][1], 'token'), false);
  assert.deepEqual(await runtime.getProviderConfig(manifest.id), safe);
  await runtime.disable(manifest.id);
  assert.equal(await runtime.getProviderConfig(manifest.id), null);
  await assert.rejects(
    runtime.setProviderConfig(manifest.id, safe),
    (error) => error.code === 'PLUGIN_DISABLED'
  );
});

test('provider configuration accepts cloud references and loopback local endpoints', () => {
  assert.deepEqual(
    validateProviderConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-x',
      keychainTokenRef: 'keychain://selection/model-x'
    }),
    {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-x',
      keychainTokenRef: 'keychain://selection/model-x'
    }
  );
  assert.equal(
    validateProviderConfig({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3:0.6b'
    }).provider,
    'ollama'
  );
  assert.equal(
    validateProviderConfig({
      provider: 'lm-studio',
      baseUrl: 'http://localhost:1234/v1',
      model: 'local-model'
    }).provider,
    'lm-studio'
  );
});

test('provider configuration rejects unsafe endpoints and credential material', () => {
  assert.throws(
    () => validateProviderConfig({
      provider: 'ollama',
      baseUrl: 'https://api.example.test',
      model: 'local-model'
    }),
    (error) => error.code === 'PROVIDER_LOCAL_ENDPOINT_REQUIRED'
  );
  assert.throws(
    () => validateProviderConfig({
      provider: 'openai-compatible',
      baseUrl: 'http://api.example.test',
      model: 'model-x'
    }),
    (error) => error.code === 'PROVIDER_ENDPOINT_UNSAFE'
  );
  assert.throws(
    () => validateProviderConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test',
      model: 'model-x',
      token: 'do-not-accept'
    }),
    (error) => error.code === 'PROVIDER_SECRET_FORBIDDEN'
  );
});

test('cloud provider resolves a Keychain token reference without exposing the token in config or request body', async () => {
  const calls = [];
  const fixtureCredential = ['fixture', 'value'].join('-');
  const config = validateProviderConfig({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    model: 'model-x',
    keychainTokenRef: 'keychain://selection/model-x'
  });
  const router = createProviderRouter({
    config,
    keychain: {
      getToken: async (reference) => {
        assert.equal(reference, config.keychainTokenRef);
        return fixtureCredential;
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: ' translated ' } }] })
      };
    }
  });

  assert.equal(await router.translate({ text: 'source', targetLanguage: 'zh-CN' }), 'translated');
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${fixtureCredential}`);
  assert.equal(JSON.stringify(calls[0].options.body).includes(fixtureCredential), false);
  assert.equal(JSON.stringify(redactProviderConfig(config)).includes(fixtureCredential), false);
});

test('local providers route to their local API without reading a Keychain token', async () => {
  const calls = [];
  const router = createProviderRouter({
    config: {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'local-model'
    },
    keychain: {
      getToken: async () => {
        throw new Error('must not read local token');
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ message: { content: 'local result' } }) };
    }
  });

  assert.equal(await router.explain({ text: 'source', locale: 'zh-CN' }), 'local result');
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal('authorization' in calls[0].options.headers, false);
});

test('LM Studio uses the OpenAI-compatible local chat endpoint', async () => {
  const calls = [];
  const router = createProviderRouter({
    config: {
      provider: 'lmStudio',
      baseURL: 'http://localhost:1234/v1',
      model: 'local-model'
    },
    keychain: { getToken: async () => { throw new Error('must not read local token'); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'local explanation' } }] }) };
    }
  });
  assert.equal(await router.explain({ text: 'source', locale: 'zh-CN' }), 'local explanation');
  assert.equal(calls[0].url, 'http://localhost:1234/v1/chat/completions');
  assert.equal('authorization' in calls[0].options.headers, false);
});

test('OpenAI-compatible loopback endpoints can run without a cloud token', async () => {
  const calls = [];
  const router = createProviderRouter({
    config: {
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'local-compatible-model'
    },
    keychain: { getToken: async () => { throw new Error('must not read local token'); } },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'local result' } }] }) };
    }
  });
  assert.equal(await router.translate({ text: 'source', targetLanguage: 'en-US' }), 'local result');
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal('authorization' in calls[0].options.headers, false);
});

test('cloud provider reports a stable token-required error before making a request', async () => {
  let requests = 0;
  const router = createProviderRouter({
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-x'
    },
    fetchImpl: async () => {
      requests += 1;
      throw new Error('must not fetch');
    }
  });
  await assert.rejects(
    router.translate({ text: 'source', targetLanguage: 'zh-CN' }),
    (error) => error.code === 'PROVIDER_TOKEN_REQUIRED'
  );
  assert.equal(requests, 0);
});

test('provider config store only persists the redacted contract', async () => {
  const writes = [];
  const store = createProviderConfigStore({
    write: async (value) => writes.push(value)
  });
  const saved = await store.save({
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.test/v1',
    model: 'model-x',
    keychainTokenRef: 'keychain://selection/model-x'
  });
  assert.equal(saved.keychainTokenRef, 'keychain://selection/model-x');
  assert.equal(Object.hasOwn(writes[0], 'token'), false);
  assert.equal(Object.hasOwn(writes[0], 'apiKey'), false);
  await assert.rejects(
    store.save({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      model: 'model-x',
      apiKey: 'must-not-persist'
    }),
    (error) => error.code === 'PROVIDER_SECRET_FORBIDDEN'
  );
  assert.equal(writes.length, 1);
});
