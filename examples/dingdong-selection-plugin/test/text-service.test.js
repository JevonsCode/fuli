import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTextService, parseEndpoint } from '../src/text-service.js';

test('text service requires an explicit safe endpoint', () => {
  assert.throws(() => parseEndpoint(''), (error) => error.code === 'TEXT_SERVICE_NOT_CONFIGURED');
  assert.throws(
    () => parseEndpoint('http://example.com/text'),
    (error) => error.code === 'TEXT_SERVICE_ENDPOINT_UNSAFE'
  );
  assert.throws(
    () => parseEndpoint('https://user:secret@example.com/text'),
    (error) => error.code === 'TEXT_SERVICE_ENDPOINT_UNSAFE'
  );
  assert.equal(parseEndpoint('http://127.0.0.1:9000/text'), 'http://127.0.0.1:9000/text');
});

test('text service sends bounded provider requests without credentials', async () => {
  const calls = [];
  const service = createHttpTextService({
    endpoint: 'https://provider.example/text',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ text: '  translated  ' }) };
    }
  });
  assert.equal(
    await service.translate({ text: 'source', targetLanguage: 'zh-CN' }),
    'translated'
  );
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    action: 'translate',
    text: 'source',
    targetLanguage: 'zh-CN'
  });
});

test('text service rejects malformed provider output', async () => {
  const service = createHttpTextService({
    endpoint: 'https://provider.example/text',
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: 'missing text' }) })
  });
  await assert.rejects(
    service.explain({ text: 'source', locale: 'zh-CN' }),
    (error) => error.code === 'TEXT_SERVICE_RESPONSE_INVALID'
  );
});

test('text service module exposes the formal Provider router configuration seam', async () => {
  const service = createHttpTextService({
    config: {
      provider: 'lmStudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model'
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'configured result' } }] })
    })
  });
  assert.equal(
    await service.translate({ text: 'source', targetLanguage: 'zh-CN' }),
    'configured result'
  );
});
