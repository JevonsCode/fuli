#!/usr/bin/env node
// Dev only, never shipped: a local proxy between a client and its model API, so
// FULI's real token cost can be read from the whole request (Jevons 11-04: the
// hook can't see a client's system prompt or built-in tools).
//
//   node scripts/dev-model-capture/proxy.js [--port 8788] [--upstream https://api.anthropic.com] [--out <dir>]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude -p "..."
//   node scripts/dev-model-capture/proxy.js --report [--out <dir>] [--last 5]
//
// It listens on this computer only and forwards everything unchanged. Request
// headers are never written, so a key or sign-in token stays out of the files.
// The files do hold the full prompt: they stay in --out and the newest 50 are kept.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { reportLine, requestSections, usageFrom } from './report.js';

const KEEP = 50;
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);

function option(args, name, fallback) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

function keepNewest(directory) {
  const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  for (const name of files.slice(0, Math.max(0, files.length - KEEP))) rmSync(join(directory, name), { force: true });
}

function record(directory, sequence, body, responseText) {
  const parsed = JSON.parse(body);
  const entry = { at: new Date().toISOString(), model: parsed.model ?? null, sections: requestSections(parsed),
    usage: usageFrom(responseText), body: parsed };
  writeFileSync(join(directory, `${entry.at.replace(/[:.]/g, '-')}-${sequence}.json`), JSON.stringify(entry));
  keepNewest(directory);
}

export function startProxy({ port, upstream, directory, log = console.log }) {
  mkdirSync(directory, { recursive: true });
  const target = new URL(upstream);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  let sequence = 0;
  const server = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !HOP_HEADERS.has(name)));
      const forward = send({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
        path: incoming.url, method: incoming.method,
        // Identity, so usage can be read from the answer as it passes through.
        headers: { ...headers, host: target.host, 'accept-encoding': 'identity', 'content-length': body.length } }, (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        const seen = [];
        answer.on('data', (chunk) => { seen.push(chunk); outgoing.write(chunk); });
        answer.on('end', () => {
          outgoing.end();
          if (incoming.method !== 'POST' || !/\/messages(\?|$)/.test(incoming.url ?? '')) return;
          try {
            record(directory, ++sequence, body.toString('utf8'), Buffer.concat(seen).toString('utf8'));
            log(`captured ${incoming.url} (${body.length} bytes)`);
          } catch (error) { log(`not captured: ${error?.name ?? 'error'}`); }
        });
      });
      forward.on('error', (error) => {
        log(`upstream failed: ${error?.code ?? error?.name ?? 'error'}`);
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      forward.end(body);
    });
  });
  return new Promise((resolve) => { server.listen(port, '127.0.0.1', () => resolve(server)); });
}

function printReport(directory, last) {
  const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort().slice(-last);
  const lines = files.map(name => reportLine(JSON.parse(readFileSync(join(directory, name), 'utf8'))));
  console.log(JSON.stringify(lines, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const directory = option(args, '--out', join(tmpdir(), 'fuli-model-capture'));
  if (args.includes('--report')) printReport(directory, Number(option(args, '--last', '5')));
  else {
    const port = Number(option(args, '--port', '8788'));
    const upstream = option(args, '--upstream', 'https://api.anthropic.com');
    await startProxy({ port, upstream, directory });
    console.log(`model capture on http://127.0.0.1:${port} -> ${upstream}, files in ${directory}`);
  }
}
