import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GraphRuntimeConfigurationError,
  canonicalProviderUrl,
  readGraphRuntimeConfig,
  resolveGraphRuntimeOptions
} from '../src/graphiti/runtime-config.js';

test('Graphiti runtime reports a safe setup command when config is missing', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'fuli-missing-graph-')), 'runtime.json');
  assert.throws(() => readGraphRuntimeConfig(missing), (error) => {
    assert.equal(error instanceof GraphRuntimeConfigurationError, true);
    assert.match(error.message, /node src\/graphiti\/setup\.js/);
    assert.equal(error.message.includes(missing), false);
    return true;
  });
});

test('Graphiti runtime accepts only HTTPS or loopback Provider origins', () => {
  assert.equal(canonicalProviderUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(canonicalProviderUrl('https://provider.example/'), 'https://provider.example');
  for (const unsafe of [
    'http://provider.example',
    'https://user:password@provider.example',
    'https://provider.example/path',
    'file:///tmp/provider'
  ]) assert.throws(() => canonicalProviderUrl(unsafe), GraphRuntimeConfigurationError);
});

test('Graphiti runtime config validates identities and preserves tokens in memory only', () => {
  const root = mkdtempSync(join(tmpdir(), 'fuli-graph-config-'));
  const path = join(root, 'runtime.json');
  writeFileSync(path, JSON.stringify({
    version: 1,
    personal: {
      providerUrl: 'http://localhost:8787/',
      accessToken: 'personal-token',
      principalId: 'principal-1',
      spaceId: 'space-1'
    },
    workspaces: []
  }));
  const config = readGraphRuntimeConfig(path);
  assert.equal(config.personal.providerUrl, 'http://localhost:8787');
  assert.equal(config.personal.accessToken, 'personal-token');
  assert.equal(resolveGraphRuntimeOptions(['--runtime-config', path]).runtimeConfigPath, path);
});
