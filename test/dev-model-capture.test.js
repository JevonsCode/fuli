import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startProxy } from '../scripts/dev-model-capture/proxy.js';
import { opensTurn, reportLine, requestParts, requestSections, usageFrom } from '../scripts/dev-model-capture/report.js';
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

test('tokens come from the answer, across streamed events, and are shared out by bytes', () => {
  const usage = usageFrom('data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90}}}\n\ndata: {"usage":{"output_tokens":5}}\n');
  assert.deepEqual(usage, { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 });
  const line = reportLine({ at: 'now', model: 'm', usage, sections: { system: 300, fuliTools: 100 } });
  assert.equal(line.inputTokens, 100);
  assert.equal(line.sections.fuliTools.tokens, 25);
  assert.equal(line.sections.fuliTools.share, 25);
  assert.equal(usageFrom('no usage here'), null);
});

test('the proxy passes the request through unchanged and keeps credentials out of its files', async (t) => {
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
  const proxy = await startProxy({ port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, directory, log: () => {} });
  t.after(async () => { proxy.close(); upstream.close(); await rm(directory, { recursive: true, force: true }); });

  const answer = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
    headers: { 'x-api-key': 'synthetic-secret-key', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).usage.input_tokens, 7);
  assert.equal(seen[0].key, 'synthetic-secret-key');
  assert.deepEqual(JSON.parse(seen[0].body), body);

  await new Promise(done => setTimeout(done, 50));
  const [file] = await readdir(directory);
  const stored = await readFile(join(directory, file), 'utf8');
  assert.doesNotMatch(stored, /synthetic-secret-key/);
  assert.equal(JSON.parse(stored).usage.input_tokens, 7);
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

test('with a data folder the proxy puts the turn on the Debug page', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fuli-model-capture-'));
  const upstream = createServer((request, response) => {
    request.resume();
    request.on('end', () => { response.writeHead(200); response.end('{"usage":{"input_tokens":7}}'); });
  }).listen(0, '127.0.0.1');
  await new Promise(done => upstream.once('listening', done));
  const proxy = await startProxy({ port: 0, upstream: `http://127.0.0.1:${upstream.address().port}`, directory: join(directory, 'raw'), dataDir: directory, log: () => {} });
  t.after(async () => { proxy.close(); upstream.close(); await rm(directory, { recursive: true, force: true }); });
  await (await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST', body: JSON.stringify(body) })).text();
  await new Promise(done => setTimeout(done, 50));
  const [listed] = debugTurnStore(directory).list();
  assert.equal(listed.promptLine, 'Hello.');
});
