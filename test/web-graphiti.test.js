import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const index = readFileSync('web/index.html', 'utf8');
const main = readFileSync('web/src/main.ts', 'utf8');
const layout = readFileSync('web/src/layouts/ConsoleLayout.vue', 'utf8');
const routes = readFileSync('web/src/router/index.ts', 'utf8');
const routePaths = readFileSync('web/src/router/paths.ts', 'utf8');
const legacyRoutes = readFileSync('web/src/router/legacy.ts', 'utf8');
const store = readFileSync('web/src/stores/console.ts', 'utf8');
const workspace = readFileSync(
  'web/src/features/knowledge/KnowledgeWorkspace.vue',
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
const publicProjects = readFileSync('web/src/pages/PublicProjectsPage.vue', 'utf8');
const review = readFileSync('web/src/pages/ReviewPage.vue', 'utf8');
const connections = readFileSync('web/src/pages/ConnectionsPage.vue', 'utf8');
const css = readFileSync('web/styles.css', 'utf8');
const vueCss = readFileSync('web/src/styles/vue.css', 'utf8');

test('the console boots from one Vue 3 application entry', () => {
  assert.match(index, /id="app"/);
  assert.match(index, /src="\/src\/main\.ts"/);
  assert.doesNotMatch(index, /src="\/app\.js"|vendor\/d3/);
  assert.match(main, /createApp\(App\)/);
  assert.match(main, /createPinia\(\)/);
  assert.match(main, /app\.use\(router\)/);
  assert.match(main, /import \* as d3 from 'd3'/);
});

test('Vue Router owns primary navigation and addressable knowledge state', () => {
  for (const path of [
    "'/preferences'",
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
  assert.match(legacyRoutes, /view.*personal-projects/s);
  assert.match(legacyRoutes, /legacyKnowledgeHash/);
  assert.doesNotMatch(layout, /pushState|popstate|URLSearchParams/);
});

test('state and API effects live outside page templates', () => {
  assert.match(store, /defineStore\('console'/);
  assert.match(store, /getJson<ConsoleState>\('\/api\/state'\)/);
  assert.match(store, /\/api\/capture-policy/);
  assert.match(store, /\/api\/agent-access-policy/);
  assert.match(layout, /自动沉淀/);
  assert.match(layout, /Agent 使用/);
  assert.match(layout, /允许 Agent 调用 FULI/);
  assert.match(layout, /Graphiti \/ Neo4j/);
});

test('knowledge directory, graph, filters, context, and exact item links share one feature', () => {
  assert.match(workspace, /内容目录/);
  assert.match(workspace, /关系图谱/);
  assert.match(workspace, /aria-label="目录内容类型"/);
  assert.match(workspace, /directory-tab-knowledge/);
  assert.match(workspace, /directory-tab-materials/);
  assert.match(workspace, /aria-label="知识内容状态"/);
  assert.match(workspace, /data-status="historical"/);
  assert.doesNotMatch(workspace, /compactFilteredCount|control-id="knowledge-status-filter"/);
  assert.match(workspace, /contextPersonalProjectId/);
  assert.doesNotMatch(workspace, /personalProfileGraph|readGraph\(null\)/);
  assert.match(workspace, /currentKnowledgeGraph/);
  assert.match(workspace, /itemKind: item\.itemKind/);
  assert.match(workspace, /providerUrl/);
  assert.match(graphCanvas, /renderKnowledgeGraph/);
  assert.match(inspector, /证据与来源/);
  assert.match(inspector, /修订历史/);
  assert.match(workspace, /knowledge-human-change-filter/);
  assert.match(workspace, /human-change-badge/);
  assert.match(inspector, /人工与 Agent 记录/);
  assert.doesNotMatch(
    `${workspace}${graphCanvas}${inspector}`,
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
  assert.match(profile, /协作偏好/);
  assert.match(profile, /疑似冲突/);
  assert.match(publicProjects, /\/api\/subscriptions/);
  assert.match(publicProjects, /\/api\/project-relations/);
  assert.match(publicProjects, /查看知识图谱/);
  assert.match(review, /\/api\/personal-review/);
  assert.match(review, /\/api\/review/);
  assert.match(review, /公共项目维护审核/);
  assert.match(connections, /服务连接与订阅/);
  assert.match(connections, /取消订阅/);
});

test('the migrated UI keeps the restrained visual system and routed anchor states', () => {
  assert.match(css, /background:\s*#f4f5f3/);
  assert.match(css, /html, body \{ height: 100%; overflow: hidden; \}/);
  assert.match(vueCss, /\.primary-nav a\.is-active/);
  assert.match(vueCss, /\.vue-knowledge-view/);
  assert.doesNotMatch(`${css}${vueCss}`, /linear-gradient|radial-gradient/);
});
