import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const connectionStyles = readFileSync('web/src/styles/connections.css', 'utf8');
const styles = `${readFileSync('web/styles.css', 'utf8')}\n${connectionStyles}`;

test('connection sections are cards on the page width and keep accessible help links', () => {
  // Connections are a settings tab: its cards, and external knowledge as one of them.
  const tab = readFileSync('web/src/features/settings/ConnectionsSettingsTab.vue', 'utf8');
  const page = readFileSync('web/src/features/connections/ExternalKnowledgeSettings.vue', 'utf8');
  // D-03: each section is a shared Card; no hand-made dividers.
  assert.match(page, /<Card as="section" id="external-knowledge" class="settings-card external-knowledge-section"/);
  assert.match(tab, /<ConflictPolicyCard v-if="hasProjects" class="settings-card" \/>/);
  const conflictCard = readFileSync('web/src/features/connections/ConflictPolicyCard.vue', 'utf8');
  assert.match(conflictCard, /<Card as="section" class="conflict-policy-section"/);
  // The page sets no width of its own: its cards sit one under another in the shared
  // PageStack, never in two columns that scroll together (Jevons 11-13).
  assert.doesNotMatch(`${tab}${page}`, /max-w-|--(canvas|layout|column|form)-max|--form-measure/);
  assert.match(tab, /<PageStack>/);
  assert.doesNotMatch(styles, /\.external-knowledge-section, \.conflict-policy-section/);
  const helpRule = styles.match(/\.section-help-link\s*\{(?<body>[^}]*)\}/);

  assert.ok(helpRule?.groups?.body);
  assert.match(helpRule.groups.body, /width:\s*17px/);
  assert.match(helpRule.groups.body, /height:\s*17px/);
  assert.match(helpRule.groups.body, /border-radius:\s*50%/);
});

test('external knowledge create action uses a flat button and a geometry-based centered icon', () => {
  const actionStart = connectionStyles.indexOf('.external-create-action-icon {');
  const actionEnd = connectionStyles.indexOf('@media', actionStart);
  const actionStyles = connectionStyles.slice(actionStart, actionEnd);

  assert.notEqual(actionStart, -1);
  assert.notEqual(actionEnd, -1);
  assert.doesNotMatch(actionStyles, /linear-gradient/);
  assert.doesNotMatch(actionStyles, /box-shadow/);
  const page = readFileSync('web/src/features/connections/ExternalKnowledgeSettings.vue', 'utf8');
  // The create action is the shared Button in its primary (default) variant; the flat accent
  // fill comes from the design system: bg-primary, and --primary is the semantic accent.
  assert.match(page, /<Button\s+class="external-create-action"/);
  const button = readFileSync('web/src/components/ui/button/index.ts', 'utf8');
  assert.match(button, /default:\s*"[^"]*\bbg-primary\b/);
  const componentTokens = readFileSync('web/src/styles/theme/components.css', 'utf8');
  assert.match(componentTokens, /--primary:\s*var\(--color-accent\)/);
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
