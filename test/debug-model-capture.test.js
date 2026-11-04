import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { request as httpRequest } from 'node:http';
import { createModelCapture } from '../src/debug-turns/model-capture.js';
import { opensTurn, requestParts, requestSections, usageFrom } from '../src/debug-turns/model-request.js';
import { buildModelRequestRecord } from '../src/debug-turns/record.js';
import { debugTurnStore } from '../src/debug-turns/store.js';

const body = { model: 'synthetic-model', system: [{ type: 'text', text: 'Synthetic system.' }],
  tools: [{ name: 'Read', description: 'x' }, { name: 'mcp__fuli__fuli_call', description: 'y' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Fuli task context. Synthetic.' }, { type: 'text', text: 'Hello.' }] }] };

test('a request is split by source, FULI\'s tools and context apart from the client\'s', () => {
  const sections = requestSections(body);
  assert.ok(sections.fuliTools > 0 && sections.clientTools > 0);
  assert.equal(sections.fuliContext, Buffer.byteLength('Fuli task context. Synthetic.'));
  assert.ok(sections.conversation > 0);
});

test('only FULI\'s own piece of a shared block counts as FULI\'s', () => {
  const entry = '<system-reminder>Fuli task context. Synthetic.</system-reminder>';
  const files = '<system-reminder>Contents of CLAUDE.md: mentions taskContextToken</system-reminder>';
  const sections = requestSections({ messages: [{ role: 'user', content: `${files}${entry}Hello.` }] });
  assert.equal(sections.fuliContext, Buffer.byteLength(entry));
});

test('one hook\'s context is told from another\'s in the same block', () => {
  const fuli = 'UserPromptSubmit hook additional context: Fuli task context. Synthetic.';
  const other = 'SessionStart hook additional context: another plugin, long text.';
  const sections = requestSections({ messages: [{ role: 'system', content: `${other}\n${fuli}` }] });
  assert.equal(sections.fuliContext, Buffer.byteLength(fuli));
});

test('tokens come from the answer, across streamed events', () => {
  const usage = usageFrom('data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90}}}\n\ndata: {"usage":{"output_tokens":5}}\n');
  assert.deepEqual(usage, { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 });
  assert.equal(usageFrom('no usage here'), null);
});

test('the request that opens a turn becomes a Debug record with everything in it', () => {
  assert.equal(opensTurn(body), true);
  assert.equal(opensTurn({ ...body, tools: [] }), false, 'a side request such as a title is left out');
  assert.equal(opensTurn({ ...body, messages: [...body.messages, { role: 'system', content: 'A host note.' }] }), true, 'a host note after the prompt changes nothing');
  assert.equal(opensTurn({ ...body, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }), false);
  const { prompt, parts } = requestParts(body, { input_tokens: 7 });
  assert.equal(prompt, 'Hello.');
  const record = buildModelRequestRecord({ sourceApplication: 'claude_code', prompt, parts });
  const kinds = record.parts.map(({ source, kind }) => `${source}:${kind}`);
  assert.deepEqual(kinds, ['host:model_system', 'host:model_client_tools', 'fuli:model_fuli_tools', 'fuli:model_context', 'person:prompt', 'host:model_usage']);
  assert.match(record.parts[0].text, /Synthetic system/);
  assert.ok(record.totals.fuli > 0);
});

test('a host\'s system message is never counted as the person\'s words', () => {
  const { parts } = requestParts({ tools: [{ name: 'Read' }], messages: [{ role: 'user', content: 'Hello.' }, { role: 'system', content: 'A long host note.' }] });
  assert.deepEqual(parts.filter(({ source }) => source === 'person').map(({ text }) => text), ['Hello.']);
});

test('the capture forwards unchanged, keeps the turn, and keeps credentials out', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-model-capture-'));
  const seen = [];
  const upstream = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ key: request.headers['x-api-key'], body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"usage":{"input_tokens":7,"output_tokens":1}}');
    });
  }).listen(0, '127.0.0.1');
  await new Promise(done => upstream.once('listening', done));
  const store = debugTurnStore(directory);
  const capture = createModelCapture({ store, upstream: `http://127.0.0.1:${upstream.address().port}`, port: 0, send: httpRequest });
  t.after(async () => { await capture.close(); upstream.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(capture.status().on, false, 'off until the person turns it on');
  const { port } = await capture.set(true);

  const answer = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
    headers: { 'x-api-key': 'synthetic-secret-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await answer.json()).usage.input_tokens, 7);
  assert.equal(seen[0].key, 'synthetic-secret-key');
  assert.deepEqual(JSON.parse(seen[0].body), body);

  const fromPage = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { origin: 'http://example.test' }, body: '{}' });
  assert.equal(fromPage.status, 403);
  assert.equal(seen.length, 1, 'a web page never reaches the model through the capture');

  await new Promise(done => setTimeout(done, 50));
  const [listed] = store.list();
  assert.equal(listed.promptLine, 'Hello.');
  const files = await readdir(join(directory, 'debug-turns'));
  const stored = await readFile(join(directory, 'debug-turns', files.find(name => name.endsWith('.json'))), 'utf8');
  assert.doesNotMatch(stored, /synthetic-secret-key/);
  await capture.set(false);
  assert.equal(capture.status().on, false);
});
