// rec#48: the shared input checks put the caller's label into the message an
// Agent or a person reads (invalid_input, or connector_response_invalid for a
// remote response). A label is a constant field name;
// a value interpolated into it would echo what the caller sent, which may be a
// secret or a user path. This scans every call site in the product source.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VALUES_MODULE = '/validation/values.js';
const SOURCES = ['src', ...readdirSync(join(ROOT, 'packages')).map(name => join('packages', name, 'src'))];
const CHECKS = new Set(['requiredString', 'requiredBinding', 'requiredResponseString', 'positiveInteger', 'uniqueTextArray', 'assertJsonObject']);
// What a template label may interpolate: a label the caller passed down, the
// item label built from one, and an array position. A bare identifier label
// may only be a forwarded `label` parameter.
const LABEL_PARTS = new Set(['label', 'itemLabel', 'index']);
// Reviewed label expressions that are constant although the rule above cannot
// tell, each with the reason. One that no longer occurs fails the test.
const REVIEWED = new Map([
  ['src/model-backends/config.js `${label}.${key}`', 'key is a BUDGET_LIMITS key, a constant table'],
  ['src/http/knowledge-tags-api-router.js name', 'numberParam is called only with literal query parameter names']
]);

function sourceFiles(directory) {
  return readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path);
    return entry.name.endsWith('.js') ? [path.split(sep).join('/')] : [];
  });
}

function constantLabel(label) {
  if (!label) return false;
  if (ts.isStringLiteral(label) || ts.isNoSubstitutionTemplateLiteral(label)) return true;
  if (ts.isTemplateExpression(label)) {
    return label.templateSpans.every(span => ts.isIdentifier(span.expression) && LABEL_PARTS.has(span.expression.text));
  }
  return ts.isIdentifier(label) && label.text === 'label';
}

// Every call of a shared check in `text` whose label is not constant, as
// `<file> <label expression>`, and how many calls were seen.
function labelFindings(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const local = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.endsWith(VALUES_MODULE)) continue;
    for (const element of statement.importClause?.namedBindings?.elements ?? []) {
      const imported = (element.propertyName ?? element.name).text;
      if (CHECKS.has(imported)) local.set(element.name.text, imported);
    }
  }
  const findings = [];
  let calls = 0;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && local.has(node.expression.text)) {
      calls += 1;
      const label = node.arguments[1];
      if (!constantLabel(label)) {
        const where = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push({ key: `${file} ${label ? label.getText(source) : '(none)'}`, where: `${file}:${where}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, calls };
}

test('every shared input check names a constant label, never a value the caller sent', () => {
  let calls = 0;
  const unreviewed = [];
  const seen = new Set();
  for (const file of SOURCES.flatMap(sourceFiles)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (!text.includes(VALUES_MODULE)) continue;
    const result = labelFindings(file, text);
    calls += result.calls;
    for (const finding of result.findings) {
      if (REVIEWED.has(finding.key)) seen.add(finding.key);
      else unreviewed.push(`${finding.where} ${finding.key.slice(finding.key.indexOf(' ') + 1)}`);
    }
  }
  assert.ok(calls > 100, `the scan reached the call sites (${calls})`);
  assert.deepEqual(unreviewed, [], 'pass a constant field name as the label');
  assert.deepEqual([...REVIEWED.keys()].filter(key => !seen.has(key)), [], 'a reviewed label that no longer occurs is removed');
});

test('the label scan flags labels built from values', () => {
  const { findings, calls } = labelFindings('synthetic.js', `
    import { requiredString as text, positiveInteger, assertJsonObject } from '../validation/values.js';
    text(input.name, 'name');
    text(input.name, \`items[\${index}].name\`);
    text(input.name, input.field);
    text(input.name, \`\${input.name} id\`);
    positiveInteger(input.limit, name, 10);
    text(input.name);
    assertJsonObject(group, \`Claude Code \${event} hook group\`);
    unrelated(input.name, input.field);
  `);
  assert.equal(calls, 7);
  assert.deepEqual(findings.map(finding => finding.key), ['synthetic.js input.field', 'synthetic.js `${input.name} id`',
    'synthetic.js name', 'synthetic.js (none)', 'synthetic.js `Claude Code ${event} hook group`']);
});
