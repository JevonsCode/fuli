import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { reachableModules } from '../test-support/module-graph.js';

// rec#11 D-34.3: a pull request skips the Neo4j jobs unless it changes a path in
// the CI `neo4j` filter. A Neo4j test that starts depending on a path the filter
// leaves out would let a breaking change merge without running it.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const topDirectories = readdirSync(root).filter(name => name !== '.git' && statSync(`${root}/${name}`).isDirectory());
const pathLiteral = new RegExp(`['"]/?((?:${topDirectories.map(name => name.replace(/[.-]/g, '\\$&')).join('|')})/[^'"\\s{}]+)['"]`, 'g');

function neo4jFilter() {
  const lines = read('.github/workflows/ci.yml').split('\n');
  const start = lines.findIndex((line, index) => /^\s+neo4j:\s*$/.test(line) && /filters: \|/.test(lines[index - 1] ?? ''));
  assert.ok(start > 0, 'ci.yml has a paths-filter `neo4j` list');
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    const entry = line.match(/^\s+- '([^']+)'\s*$/);
    if (!entry) break;
    patterns.push(entry[1]);
  }
  return patterns;
}

const covered = (patterns, path) => patterns.some(pattern => pattern.endsWith('/**')
  ? path.startsWith(pattern.slice(0, -2)) : path === pattern);

// Repository paths a source names as string literals: `root / 'src/...'`,
// `resolve('src/...')`, `'acceptance/...'`, `load('/src/...')`.
function referencedPaths(source) {
  return [...source.matchAll(pathLiteral)].map(match => match[1])
    .filter(path => existsSync(`${root}/${path}`));
}

function dependencyPaths() {
  const script = JSON.parse(read('package.json')).scripts['test:neo4j'];
  const nodeTests = [...script.matchAll(/test\/[\w.-]+\.test\.js/g)].map(match => match[0]);
  assert.equal(nodeTests.length, 4);
  const pythonTests = readdirSync(new URL('../graph-provider/tests/', import.meta.url))
    .filter(name => name.endsWith('.py') && name.includes('neo4j')).map(name => `graph-provider/tests/${name}`);
  const entries = [...nodeTests, 'test-support/real-task-context-provider.js',
    ...pythonTests.flatMap(path => referencedPaths(read(path)))];
  const paths = new Set();
  for (const entry of entries) {
    if (!entry.endsWith('.js')) { paths.add(entry); continue; }
    for (const module of reachableModules(`${root}/${entry}`)) {
      const path = relative(root, module).replaceAll('\\', '/');
      paths.add(path);
      if (/^(test|test-support)\//.test(path)) for (const named of referencedPaths(readFileSync(module, 'utf8'))) paths.add(named);
    }
  }
  return { nodeTests, paths: [...paths].sort() };
}

test('the CI neo4j path filter covers every path the Neo4j tests depend on', () => {
  const patterns = neo4jFilter();
  const { nodeTests, paths } = dependencyPaths();
  assert.ok(paths.some(path => path.startsWith('acceptance/')), 'the Python Neo4j cases drive acceptance scripts');
  for (const file of [...nodeTests, '.github/workflows/ci.yml', 'package.json', 'npm-shrinkwrap.json']) {
    assert.ok(covered(patterns, file), `${file} is in the neo4j filter`);
  }
  // Dependencies under node_modules change only through the lockfile.
  const missing = paths.filter(path => !path.startsWith('node_modules/') && !covered(patterns, path));
  assert.deepEqual(missing, []);
});
