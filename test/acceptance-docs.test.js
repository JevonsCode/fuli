import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const 验收目录 = new URL('../acceptance/', import.meta.url);

function 读取验收文件(文件名) {
  return readFileSync(new URL(文件名, 验收目录), 'utf8');
}

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

  assert.equal((流程图.match(/^```mermaid$/gm) ?? []).length, 4);
  assert.equal((流程图.match(/^```$/gm) ?? []).length, 4);
  assert.equal((流程图.match(/^flowchart (?:TD|LR)$/gm) ?? []).length, 4);
  assert.match(流程图, /排除其他项目偏好/);
  assert.match(流程图, /作用域距离是否不超过两跳/);
  assert.match(流程图, /状态：智能体已确认/);
  assert.match(流程图, /不使用原始象限作为个人知识权重/);
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
