import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const 验收目录 = new URL('../acceptance/', import.meta.url);
const 仓库目录 = new URL('../', import.meta.url);

function 读取验收文件(文件名) {
  return readFileSync(new URL(文件名, 验收目录), 'utf8');
}

function 读取仓库文件(文件名) {
  return readFileSync(new URL(文件名, 仓库目录), 'utf8');
}

test('中英文 README 应完整表达项目理念、证据边界和 Agent 生命周期', () => {
  const 中文 = 读取仓库文件('README.zh-CN.md');
  const 英文 = 读取仓库文件('README.md');

  assert.match(中文, /href="README\.md">English/);
  assert.match(英文, /href="README\.zh-CN\.md">简体中文/);
  assert.match(中文, /width="72"/);
  assert.match(英文, /img\.shields\.io\/npm\/v\/fuli-context/);
  assert.match(中文, /Fuli Server npm 包 \| 开发中/);
  assert.match(英文, /Fuli Server npm package \| In development/);
  assert.equal((中文.match(/^```mermaid$/gm) ?? []).length, 1);
  assert.equal((英文.match(/^```mermaid$/gm) ?? []).length, 1);

  assert.match(中文, /衡量复用价值，而不是知识数量/);
  assert.match(中文, /每个任务都检查价值，但不强迫每个任务沉淀/);
  assert.match(中文, /人始终保留最终判断权/);
  assert.match(中文, /先搜索酒店本地知识，再沿显式的 `PART_OF`/);
  assert.match(中文, /实际怎么用：分类、作用域、项目识别与取回/);
  assert.match(中文, /品味 `taste`/);
  assert.match(中文, /个性 `personality`/);
  assert.match(中文, /判断偏好 `judgment_preference`/);
  assert.match(中文, /“个性”不是所有个人信息的兜底分类/);
  assert.match(中文, /不传 `personalProjectId`/);
  assert.match(中文, /项目级个人偏好[\s\S]*不向子项目继承/);
  assert.match(中文, /不设置 `profileAspect`/);
  assert.match(中文, /Fuli 只匹配已经登记在“个人项目”中的稳定 `project_id`/);
  assert.match(中文, /多个候选返回 `ambiguous`，没有候选返回 `unmatched`/);
  assert.match(中文, /"tool": "get_collaboration_preferences"/);
  assert.match(中文, /"tool": "search_current_project_knowledge"/);
  assert.match(中文, /npm run test:node -- test\/acceptance-docs\.test\.js test\/project-path-context\.test\.js/);
  assert.match(中文, /MOCK \/ 合成数据/);
  assert.match(中文, /还没有面向既有 `Decision` 单独追加不可变验证结果/);
  assert.match(中文, /Claude Code \/ Codex（已提供 Hook 上下文）/);
  assert.match(中文, /未提供上下文（Prompt fallback，含 Cursor）/);
  assert.match(中文, /安装文件不等于宿主已加载、信任或执行/);
  assert.match(中文, /外部知识库只读接入/);
  assert.match(中文, /id="connect-external-knowledge"/);
  assert.match(中文, /同一个个人项目可以拥有多个独立知识库绑定，同一个知识库连接也可以绑定多个个人项目/);
  assert.match(中文, /id="external-knowledge-conflict-policy"/);
  assert.match(中文, /“允许 AI 本次判断”允许 Agent 为当前回答/);
  assert.match(中文, /search_connected_knowledge/);
  assert.match(中文, /公共项目聚合目前是 \*\*Beta\*\*/);
  assert.match(中文, /get_collaboration_preferences\(projectPath, taskPrompt\)/);
  assert.match(中文, /检查 task_knowledge_recall/);
  assert.match(中文, /127\.0\.0\.1:8788/);
  assert.match(中文, /python -m pip install "\.\/graph-provider\[dev\]"/);

  assert.match(英文, /Measure reuse value, not knowledge volume/);
  assert.match(英文, /not every task must become stored knowledge/);
  assert.match(英文, /humans retain final\s+authority/);
  assert.match(英文, /searches hotel-local knowledge first/);
  assert.match(英文, /Practical use: classification, scope, project resolution, and retrieval/);
  assert.match(英文, /Taste \(`taste`\)/);
  assert.match(英文, /Personality \(`personality`\)/);
  assert.match(英文, /Judgment preference \(`judgment_preference`\)/);
  assert.match(英文, /Personality is not a catch-all category/);
  assert.match(英文, /omit `personalProjectId`/);
  assert.match(英文, /Project-scoped personal preference[\s\S]*never inherited by child projects/);
  assert.match(英文, /project facts omit `profileAspect`/);
  assert.match(英文, /matches only stable `project_id` values already registered/);
  assert.match(英文, /Multiple candidates return `ambiguous`; no candidate returns `unmatched`/);
  assert.match(英文, /"tool": "get_collaboration_preferences"/);
  assert.match(英文, /"tool": "search_current_project_knowledge"/);
  assert.match(英文, /npm run test:node -- test\/acceptance-docs\.test\.js test\/project-path-context\.test\.js/);
  assert.match(英文, /MOCK \/ synthetic data/);
  assert.match(英文, /does not yet expose a[\s\S]*dedicated operation/);
  assert.match(英文, /Claude Code \/ Codex \(hook context supplied\)/);
  assert.match(英文, /No hook context \(prompt fallback, including Cursor\)/);
  assert.match(英文, /Installed files do not prove host loading, trust, or execution/);
  assert.match(英文, /Read-only external knowledge/);
  assert.match(英文, /id="connect-external-knowledge"/);
  assert.match(英文, /One personal project can have multiple knowledge connections, and one connection can target[s\n]+multiple personal projects/);
  assert.match(英文, /id="external-knowledge-conflict-policy"/);
  assert.match(英文, /Allow an Agent decision lets the Agent select/);
  assert.match(英文, /search_connected_knowledge/);
  assert.match(英文, /Public-project aggregation is \*\*Beta\*\*/);
  assert.match(英文, /get_collaboration_preferences\(projectPath, taskPrompt\)/);
  assert.match(英文, /Inspect task_knowledge_recall/);
  assert.match(英文, /127\.0\.0\.1:8788/);
  assert.match(英文, /python -m pip install "\.\/graph-provider\[dev\]"/);
});

test('中文验收索引应链接全部人工检查文件', () => {
  const 索引 = 读取验收文件('README.md');

  for (const 文件名 of [
    '知识验收用例.md',
    '智能体调用时序图.md',
    '知识检索与确认流程图.md',
    'knowledge-live.js'
  ]) {
    assert.match(索引, new RegExp(`\\(\\./${文件名.replace('.', '\\.')}\\)`));
  }
});

test('九个知识验收用例都应使用中文描述完整验收步骤', () => {
  const 用例文档 = 读取验收文件('知识验收用例.md');
  const 用例章节 = 用例文档.split(/^### (?=KAC-\d{2})/m).slice(1);

  assert.equal(用例章节.length, 9);
  for (let 序号 = 1; 序号 <= 9; 序号 += 1) {
    const 用例编号 = `KAC-${String(序号).padStart(2, '0')}`;
    const 用例 = 用例章节.find((内容) => 内容.startsWith(用例编号));
    assert.ok(用例, `缺少中文验收用例 ${用例编号}`);
    assert.match(用例, /前置条件：/);
    assert.match(用例, /操作步骤：/);
    assert.match(用例, /预期结果：/);
    assert.match(用例, /[\u3400-\u9fff]/, `${用例编号} 必须包含中文说明`);
  }
});

test('可执行验收脚本应输出中文用例名称和中文通过状态', () => {
  const 执行脚本 = 读取验收文件('knowledge-live.js');
  const 用例编号 = [...执行脚本.matchAll(/id: '(KAC-\d{2})'/g)]
    .map((匹配) => 匹配[1])
    .sort();
  const 用例标题 = [...执行脚本.matchAll(/title: '([^']+)'/g)]
    .map((匹配) => 匹配[1]);

  assert.deepEqual(
    用例编号,
    Array.from({ length: 9 }, (_, 索引) => `KAC-${String(索引 + 1).padStart(2, '0')}`)
  );
  assert.equal(用例标题.length, 9);
  assert.ok(用例标题.every((标题) => /[\u3400-\u9fff]/.test(标题)));
  assert.doesNotMatch(执行脚本, /status: 'passed'/);
  assert.match(执行脚本, /status: '通过'/);
});

test('时序图和流程图应使用完整的中文 Mermaid 图示', () => {
  const 时序图 = 读取验收文件('智能体调用时序图.md');
  const 流程图 = 读取验收文件('知识检索与确认流程图.md');

  assert.equal((时序图.match(/^```mermaid$/gm) ?? []).length, 1);
  assert.equal((时序图.match(/^```$/gm) ?? []).length, 1);
  assert.match(时序图, /^sequenceDiagram$/m);
  assert.match(时序图, /读取协作偏好/);
  assert.match(时序图, /不自动注入待确认偏好/);
  assert.match(时序图, /达到五次且跨三个任务/);
  assert.match(时序图, /预览项目写入/);
  assert.match(时序图, /一次性预览令牌/);
  assert.match(时序图, /未命中时只显示顶部标记，不重复页脚/);
  assert.match(时序图, /UserPromptSubmit 调用 begin_task_context/);
  assert.match(时序图, /checkpoint_task_knowledge/);
  assert.match(时序图, /capture_candidates/);
  assert.match(时序图, /retain_nothing/);
  assert.match(时序图, /Prompt fallback/);
  assert.match(时序图, /当前尚无针对既有 Decision 单独追加验证的专用入口/);
  assert.match(时序图, /三方知识库（只读）/);
  assert.match(时序图, /不确认、不失效、不改写任何来源/);
  assert.match(时序图, /TODO：外部绑定直接指向公共空间/);

  assert.equal((流程图.match(/^```mermaid$/gm) ?? []).length, 4);
  assert.equal((流程图.match(/^```$/gm) ?? []).length, 4);
  assert.equal((流程图.match(/^flowchart (?:TD|LR)$/gm) ?? []).length, 4);
  assert.match(流程图, /排除其他项目偏好/);
  assert.match(流程图, /作用域距离是否不超过两跳/);
  assert.match(流程图, /状态：智能体已确认/);
  assert.match(流程图, /不使用原始象限作为个人知识权重/);
  assert.match(流程图, /绑定模式是什么/);
  assert.match(流程图, /公共项目（Beta）/);
  assert.match(流程图, /Agent 本次判断/);
});

test('外部知识架构文档应区分已实现、Beta、TODO 和真实联网验证', () => {
  const 架构 = 读取仓库文件('docs/external-knowledge-architecture.md');
  const 包清单 = JSON.parse(读取仓库文件('package.json'));

  assert.match(架构, /第三方知识源（只读）/);
  assert.match(架构, /🟢 已实现/);
  assert.match(架构, /🟠 Beta/);
  assert.match(架构, /⚪ TODO/);
  assert.match(架构, /可信本地自定义连接器[\s\S]*不是进程沙箱/);
  assert.match(架构, /1 至 32 个已经存在的个人项目目标/);
  assert.match(架构, /ExternalKnowledgeSource/);
  assert.match(架构, /retrieval_api/);
  assert.match(架构, /默认测试使用显式标注的 fixture \/ mock/);
  assert.match(架构, /Model Context Protocol specification and documentation/);
  assert.match(架构, /Official Notion JavaScript client documentation/);
  assert.match(架构, /finally/);
  assert.equal(
    包清单.scripts['test:external-knowledge:live'],
    'node scripts/validate-external-knowledge-live.js'
  );
  assert.ok(包清单.files.includes('docs/external-knowledge-architecture.md'));
  assert.ok(包清单.files.includes('examples/external-knowledge/markdown-folder.mjs'));
});

test('中文验收口径应把误选写工具和项目写入授权纳入回归', () => {
  const 用例文档 = 读取验收文件('知识验收用例.md');

  assert.match(用例文档, /MCP-02：项目写入必须经过匹配且一次性的预览授权/);
  assert.match(用例文档, /只读任务.*尝试调用.*写入工具.*失败/s);
  assert.match(用例文档, /完整写入意图/);
  assert.match(用例文档, /预览令牌/);
  assert.match(用例文档, /重复使用.*拒绝/);
});

test('中文验收口径应覆盖运行来源、Claude Code 更新、未命中去重和 CLI 更新', () => {
  const 索引 = 读取验收文件('README.md');
  const 用例文档 = 读取验收文件('知识验收用例.md');
  const 流程图 = 读取验收文件('知识检索与确认流程图.md');

  assert.match(用例文档, /ENV-02：安装来源与当前运行来源可以明确区分/);
  assert.match(用例文档, /npm 包名为 `fuli-context`/);
  assert.match(用例文档, /CC-01：Claude Code 在真实验收前完成版本检查/);
  assert.match(用例文档, /MCP-03：未命中来源标记只展示一次/);
  assert.match(用例文档, /`noMatchSourceMarker\.markdown` 是空字符串/);
  assert.match(用例文档, /CLI-01：`fuli update` 安全更新全局 npm 安装/);
  assert.match(用例文档, /安装 `fuli-context@latest`/);
  assert.match(用例文档, /当前 CLI 高于 npm `latest` 时拒绝降级/);
  assert.match(用例文档, /WEB-01：使用包内浏览器小图标，不向回答插入大图/);
  assert.match(用例文档, /Codex 自身渲染/);
  assert.match(流程图, /未命中时只显示顶部标记/);
  assert.match(索引, /test\/update-command\.test\.js/);
  assert.match(索引, /npm run test:package/);
});
