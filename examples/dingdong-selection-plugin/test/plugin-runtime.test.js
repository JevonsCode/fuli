import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginRuntime, validatePluginManifest } from '../src/plugin-runtime.js';

const manifest = {
  schemaVersion: 1,
  id: 'selection-assistant',
  displayName: 'Selection Assistant',
  version: '0.1.0',
  entry: './src/selection-plugin.js',
  capabilities: ['selection.read', 'clipboard.write'],
  commands: [{
    id: 'copy',
    label: 'Copy',
    permissions: ['selection.read', 'clipboard.write']
  }]
};

test('manifest rejects unknown fields and undeclared permissions', () => {
  assert.throws(
    () => validatePluginManifest({ ...manifest, secret: true }),
    /unknown field: secret/
  );
  assert.throws(
    () => validatePluginManifest({
      ...manifest,
      commands: [{ ...manifest.commands[0], permissions: ['text.explain'] }]
    }),
    /undeclared capability: text.explain/
  );
});

test('validated manifest deeply freezes command permissions', () => {
  const validated = validatePluginManifest(manifest);
  assert.equal(Object.isFrozen(validated.commands[0].permissions), true);
  assert.throws(
    () => validated.commands[0].permissions.push('text.explain'),
    TypeError
  );
});

test('runtime enforces lifecycle, declarations, and command permissions', async () => {
  const writes = [];
  const events = [];
  const runtime = createPluginRuntime({
    ports: { clipboard: { writeText: async (text) => writes.push(text) } },
    onEvent: (event) => events.push(event.type)
  });
  runtime.register(manifest, () => ({
    commands: {
      copy: async ({ input, host }) => {
        const text = host.readSelection(input.selection);
        await host.writeClipboard(text);
        return text;
      }
    }
  }));
  await assert.rejects(
    runtime.execute(manifest.id, 'copy', { selection: 'hello' }),
    (error) => error.code === 'PLUGIN_NOT_ACTIVE'
  );
  await runtime.start(manifest.id);
  assert.equal(await runtime.execute(manifest.id, 'copy', { selection: ' hello ' }), 'hello');
  assert.deepEqual(writes, ['hello']);
  await assert.rejects(
    runtime.execute(manifest.id, 'translate', { selection: 'hello' }),
    (error) => error.code === 'PLUGIN_COMMAND_UNKNOWN'
  );
  await runtime.stop(manifest.id);
  assert.equal(runtime.state(manifest.id), 'stopped');
  await runtime.unregister(manifest.id);
  assert.throws(
    () => runtime.state(manifest.id),
    (error) => error.code === 'PLUGIN_NOT_REGISTERED'
  );
  assert.deepEqual(events, [
    'registered',
    'active',
    'command.started',
    'command.completed',
    'stopped',
    'unregistered'
  ]);
});

test('runtime rejects duplicate registration and missing host capabilities', async () => {
  const runtime = createPluginRuntime();
  const factory = () => ({
    commands: { copy: ({ input, host }) => host.writeClipboard(input.selection) }
  });
  runtime.register(manifest, factory);
  assert.throws(() => runtime.register(manifest, factory), (error) => error.code === 'PLUGIN_DUPLICATE');
  await runtime.start(manifest.id);
  await assert.rejects(
    runtime.unregister(manifest.id),
    (error) => error.code === 'PLUGIN_ACTIVE'
  );
  await assert.rejects(
    runtime.execute(manifest.id, 'copy', { selection: 'hello' }),
    (error) => error.code === 'HOST_CAPABILITY_UNAVAILABLE'
  );
});
