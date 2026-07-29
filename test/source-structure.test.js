import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';

const SOURCE_ROOTS = [
  'src',
  'web',
  'graph-provider/fuli_graph',
  'graph-provider/tests',
  'test'
];
const SOURCE_EXTENSIONS = new Set(['.js', '.ts', '.vue', '.py', '.css', '.html']);
const HARD_LINE_LIMIT = 1300;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === '__pycache__') return [];
      return sourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function lineCount(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).length;
}

test('source files stay below the hard size limit', () => {
  const offenders = SOURCE_ROOTS.flatMap(sourceFiles)
    .map((path) => ({ path, lines: lineCount(path) }))
    .filter(({ lines }) => lines > HARD_LINE_LIMIT);

  assert.deepEqual(
    offenders,
    [],
    `Split oversized files before adding more responsibilities:\n${offenders
      .map(({ path, lines }) => `- ${path}: ${lines} lines`)
      .join('\n')}`
  );
});

test('the Vue browser entry remains an orchestration layer', () => {
  assert.ok(
    lineCount('web/src/main.ts') <= 100,
    'web/src/main.ts should only initialize Vue and application plugins'
  );
});
