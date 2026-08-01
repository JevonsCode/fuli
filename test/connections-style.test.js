import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const connectionStyles = readFileSync('web/src/styles/connections.css', 'utf8');
const styles = `${readFileSync('web/styles.css', 'utf8')}\n${connectionStyles}`;

test('external knowledge sections use compact spacing and accessible help links', () => {
  const sectionRule = styles.match(
    /\.external-knowledge-section, \.conflict-policy-section\s*\{(?<body>[^}]*)\}/
  );
  const helpRule = styles.match(/\.section-help-link\s*\{(?<body>[^}]*)\}/);

  assert.ok(sectionRule?.groups?.body);
  assert.match(sectionRule.groups.body, /margin-top:\s*14px/);
  assert.match(sectionRule.groups.body, /padding-top:\s*12px/);

  assert.ok(helpRule?.groups?.body);
  assert.match(helpRule.groups.body, /width:\s*17px/);
  assert.match(helpRule.groups.body, /height:\s*17px/);
  assert.match(helpRule.groups.body, /border-radius:\s*50%/);
});

test('external knowledge create action uses a flat button and a geometry-based centered icon', () => {
  const actionStart = connectionStyles.indexOf('.external-create-action {');
  const actionEnd = connectionStyles.indexOf('@media', actionStart);
  const actionStyles = connectionStyles.slice(actionStart, actionEnd);

  assert.notEqual(actionStart, -1);
  assert.notEqual(actionEnd, -1);
  assert.doesNotMatch(actionStyles, /linear-gradient/);
  assert.doesNotMatch(actionStyles, /box-shadow/);
  assert.match(actionStyles, /background:\s*#426f58/);
  assert.match(actionStyles, /\.external-create-action-icon::before/);
  assert.match(actionStyles, /left:\s*50%/);
  assert.match(actionStyles, /top:\s*50%/);
  assert.match(actionStyles, /transform:\s*translate\(-50%, -50%\)/);
});

test('binding editor shares the create form width and keeps target modes compact', () => {
  const editorRule = connectionStyles.match(
    /\.external-binding-editor\s*\{(?<body>[^}]*)\}/
  );
  const modeListRule = connectionStyles.match(
    /\.external-target-mode-list\s*\{(?<body>[^}]*)\}/
  );

  assert.ok(editorRule?.groups?.body);
  assert.match(editorRule.groups.body, /grid-column:\s*1\s*\/\s*-1/);
  assert.match(editorRule.groups.body, /grid-template-columns:\s*repeat\(4,/);
  assert.match(editorRule.groups.body, /padding:\s*15px/);

  assert.ok(modeListRule?.groups?.body);
  assert.match(modeListRule.groups.body, /grid-column:\s*1\s*\/\s*-1/);
  assert.match(modeListRule.groups.body, /grid-template-columns:\s*repeat\(2,/);
});
