import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync('web/index.html', 'utf8');
const main = readFileSync('web/src/main.ts', 'utf8');
const graphRuntime = readFileSync(
  'web/src/features/knowledge/graph-runtime.ts',
  'utf8'
);
const layout = readFileSync('web/src/layouts/ConsoleLayout.vue', 'utf8');
const settings = readFileSync('web/src/pages/SettingsPage.vue', 'utf8');
const routes = readFileSync('web/src/router/index.ts', 'utf8');
const routePaths = readFileSync('web/src/router/paths.ts', 'utf8');
const store = readFileSync('web/src/stores/console.ts', 'utf8');
const workspace = readFileSync(
  'web/src/features/knowledge/KnowledgeWorkspace.vue',
  'utf8'
);
const directoryPanel = readFileSync(
  'web/src/features/knowledge/KnowledgeDirectoryPanel.vue',
  'utf8'
);
const graphCanvas = readFileSync(
  'web/src/features/knowledge/GraphCanvas.vue',
  'utf8'
);
const inspector = readFileSync(
  'web/src/features/knowledge/KnowledgeInspector.vue',
  'utf8'
);
const profile = readFileSync('web/src/pages/PersonalProfilePage.vue', 'utf8');
const writingTaste = readFileSync('web/src/pages/WritingTastePage.vue', 'utf8');
const publicProjects = readFileSync('web/src/pages/PublicProjectsPage.vue', 'utf8');
const review = readFileSync('web/src/pages/ReviewPage.vue', 'utf8');
const connections = readFileSync('web/src/pages/ConnectionsPage.vue', 'utf8');
const consoleMessages = readFileSync('web/src/i18n/messages/console.ts', 'utf8');
const knowledgeMessages = readFileSync(
  'web/src/i18n/messages/knowledge-workspace.ts',
  'utf8'
);
const preferenceMessages = readFileSync(
  'web/src/i18n/messages/preferences.ts',
  'utf8'
);
const pageMessages = readFileSync('web/src/i18n/messages/pages.ts', 'utf8');
const css = readFileSync('web/styles.css', 'utf8');
const vueCss = readFileSync('web/src/styles/vue.css', 'utf8');

test('the console boots from one Vue 3 application entry', () => {
  assert.equal(existsSync('web/js'), false);
  assert.match(index, /id="app"/);
  assert.match(index, /src="\/src\/main\.ts"/);
  assert.doesNotMatch(index, /src="\/app\.js"|vendor\/d3/);
  assert.match(main, /createApp\(App\)/);
  assert.match(main, /createPinia\(\)/);
  assert.match(main, /app\.use\(router\)/);
  assert.doesNotMatch(main, /globalThis.*d3/);
  assert.match(graphRuntime, /import \* as d3 from 'd3'/);
  assert.doesNotMatch(graphRuntime, /web\/js|js\/graph-view/);
});

test('Vue Router owns primary navigation and addressable knowledge state', () => {
  for (const path of [
    "'/preferences'",
    "'/preferences/writing'",
    "'/personal/:spaceId/projects/:mode'",
    "'/personal/:spaceId/projects/:projectId/:mode'",
    "'/public-projects'",
    "'/knowledge/:scope/:spaceId/:mode'",
    "'/review'",
    "'/connections'"
  ]) {
    assert.match(routes, new RegExp(path.replace(/[/:?*.()]/g, '\\$&')));
  }
  assert.match(layout, /RouterLink/);
  assert.match(routePaths, /personalProjectsPath/);
  assert.match(routePaths, /knowledgePath/);
  assert.doesNotMatch(layout, /pushState|popstate|URLSearchParams/);
});

test('state and API effects live outside page templates', () => {
  assert.match(store, /defineStore\('console'/);
  assert.match(store, /getJson<ConsoleState>\('\/api\/state'\)/);
  assert.match(store, /\/api\/capture-policy/);
  assert.match(store, /\/api\/agent-access-policy/);
  assert.match(settings, /updateCapturePolicy/);
  assert.match(settings, /updateAgentAccessPolicy/);
  assert.match(settings, /\/api\/system\/settings/);
  assert.match(settings, /\/api\/system\/resources/);
  assert.match(consoleMessages, /label: '自动沉淀'/);
  assert.match(consoleMessages, /label: 'Agent 使用'/);
  assert.match(consoleMessages, /aria: '允许 Agent 调用 FULI'/);
  assert.match(layout, /Graphiti \/ Neo4j/);
});

test('knowledge directory, graph, filters, context, and exact item links share one feature', () => {
  assert.match(workspace, /t\('knowledge\.workspace\.workspace\.view\.directory'\)/);
  assert.match(workspace, /t\('knowledge\.workspace\.workspace\.view\.graph'\)/);
  assert.match(workspace, /KnowledgeDirectoryPanel/);
  assert.match(knowledgeMessages, /directory: '内容目录'/);
  assert.match(knowledgeMessages, /graph: '关系图谱'/);
  assert.match(directoryPanel, /directoryTypeAria/);
  assert.match(directoryPanel, /directory-tab-knowledge/);
  assert.match(directoryPanel, /directory-tab-materials/);
  assert.match(directoryPanel, /knowledgeStatusAria/);
  assert.match(directoryPanel, /data-status="historical"/);
  assert.doesNotMatch(workspace, /compactFilteredCount|control-id="knowledge-status-filter"/);
  assert.match(workspace, /contextPersonalProjectId/);
  assert.doesNotMatch(workspace, /personalProfileGraph|readGraph\(null\)/);
  assert.match(workspace, /currentKnowledgeGraph/);
  assert.match(workspace, /itemKind: item\.itemKind/);
  assert.match(workspace, /providerUrl/);
  assert.match(graphCanvas, /renderKnowledgeGraph/);
  assert.match(inspector, /knowledge\.workspace\.inspector\.evidence/);
  assert.match(inspector, /knowledge\.workspace\.inspector\.revisions/);
  assert.match(knowledgeMessages, /evidence: '证据与来源'/);
  assert.match(knowledgeMessages, /revisions: '修订历史'/);
  assert.match(workspace, /knowledge-human-change-filter/);
  assert.match(directoryPanel, /human-change-badge/);
  assert.match(inspector, /knowledge\.workspace\.inspector\.audit/);
  assert.match(knowledgeMessages, /audit: '人工与 Agent 记录'/);
  assert.doesNotMatch(
    `${workspace}${directoryPanel}${graphCanvas}${inspector}`,
    /innerHTML|insertAdjacentHTML/
  );
});

test('knowledge directory avoids fixed-width horizontal overflow', () => {
  assert.match(
    css,
    /\.knowledge-directory-panel\s*\{[^}]*overflow-x:\s*hidden[^}]*container-type:\s*inline-size/s
  );
  assert.doesNotMatch(
    css,
    /\.knowledge-table-head,\s*\.knowledge-row\s*\{[^}]*min-width:\s*1100px/s
  );
  assert.match(css, /@container knowledge-directory/);
});

test('all existing workspace areas have Vue pages and API actions', () => {
  assert.match(profile, /preferences\.profile\.summaryAria/);
  assert.match(profile, /preferences\.profile\.summary\.conflicts/);
  assert.match(preferenceMessages, /summaryAria: '协作偏好状态'/);
  assert.match(preferenceMessages, /conflicts: '疑似冲突'/);
  assert.match(publicProjects, /\/api\/subscriptions/);
  assert.match(publicProjects, /\/api\/project-relations/);
  assert.match(publicProjects, /pages\.publicProjects\.viewGraph/);
  assert.match(review, /\/api\/personal-review/);
  assert.match(review, /\/api\/review/);
  assert.match(review, /pages\.review\.publicTitle/);
  assert.match(connections, /pages\.connections\.title/);
  assert.match(connections, /pages\.connections\.unsubscribe/);
  assert.match(pageMessages, /viewGraph: '查看知识图谱'/);
  assert.match(pageMessages, /publicTitle: '公共项目维护审核'/);
  assert.match(pageMessages, /title: '服务连接与订阅'/);
  assert.match(pageMessages, /unsubscribe: '取消订阅'/);
});

test('writing taste stays evidence-backed and separates review from Agent use', () => {
  assert.match(profile, /WritingTasteMilestone/);
  assert.match(profile, /\/api\/writing-taste-profile/);
  assert.match(writingTaste, /profile\.readiness\.criteria/);
  assert.match(writingTaste, /Working hypothesis/);
  assert.match(writingTaste, /profile\.agent_markdown/);
  assert.match(writingTaste, /KnowledgeConfirmDialog/);
  assert.match(writingTaste, /KnowledgeEditDialog/);
});

test('connection forms use the shared custom controls', () => {
  assert.match(connections, /<SearchableSelect/);
  assert.match(connections, /<TextField/);
  assert.doesNotMatch(connections, /<(?:input|select|textarea)\b/);
});

test('the UI keeps the restrained visual system and routed anchor states', () => {
  assert.match(css, /background:\s*#f4f5f3/);
  assert.match(css, /html, body \{ height: 100%; overflow: hidden; \}/);
  assert.match(vueCss, /\.primary-nav a\.is-active/);
  assert.match(vueCss, /\.vue-knowledge-view/);
  assert.doesNotMatch(`${css}${vueCss}`, /linear-gradient|radial-gradient/);
});
