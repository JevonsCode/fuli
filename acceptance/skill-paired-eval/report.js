// A reviewable result for one pair. It names the exact stored version, the
// scenario, the mode, every arm's actual output and checks, what the Skill did
// or did not do in a live arm, and every case that was not measured. A
// deterministic run says it is not live-client evidence.
const PASS = { true: '通过', false: '未通过', null: '未知' };
const YES_NO = { true: '是', false: '否', null: '未知' };
const TOKEN_SOURCE = { 'client-reported': '客户端报告', unknown: '未知', not_applicable: '不适用' };

const cell = value => String(value ?? '—').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

function duration(ms) {
  return Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : '未知';
}

function usageRow(arm) {
  if (!arm) return '| — | — | — | — | — | — | — | — |';
  const tokens = arm.evidence?.tokens;
  const reported = tokens?.source === 'client-reported';
  const value = name => (reported ? (tokens[name] ?? '未知') : (tokens?.source === 'not_applicable' ? '不适用' : '未知'));
  return `| ${cell(arm.arm)} | ${duration(arm.durationMs)} | ${value('input')} | ${value('output')} | ${value('reasoning')} `
    + `| ${value('cacheRead')} | ${value('cacheWrite')} | ${TOKEN_SOURCE[tokens?.source] ?? '未知'} |`;
}

function armRow(arm) {
  if (!arm) return '| — | — | — | — | — | — |';
  const checks = arm.grading?.checks?.map(check => `${check.pass ? '✓' : '✗'} ${check.type}`).join('<br>') ?? '—';
  return `| ${cell(arm.arm)} | ${cell(arm.task)} | ${PASS[arm.pass] ?? '未知'} | ${cell(arm.corrections?.count ?? '未知')} `
    + `| ${checks} | ${cell(arm.changedPaths.join(', ') || '无变化')} |`;
}

function listLines(label, items) {
  if (!Array.isArray(items) || !items.length) return [];
  return [`- ${label}：`, ...items.map(item => `  - ${cell(item)}`)];
}

function selectionContent(selection) {
  const steps = selection.steps.map((step, index) => `${index + 1}. **${cell(step.title)}**${step.detail ? ` — ${cell(step.detail)}` : ''}`);
  return [
    '## 选中的工作流内容',
    '',
    '步骤：',
    '',
    ...steps,
    '',
    ...(selection.lesson?.trigger ? [`- 触发：${cell(selection.lesson.trigger)}`] : []),
    ...(selection.lesson?.scope ? [`- 范围：${cell(selection.lesson.scope)}`] : []),
    ...listLines('易错点', selection.lesson?.pitfalls),
    ...listLines('验收证据', selection.lesson?.acceptanceEvidence),
    ...listLines('工作图验收', selection.workMap?.acceptance),
    ...(selection.lesson?.trigger || selection.lesson?.scope || selection.workMap?.acceptance ? [] : ['- 这条版本没有保存触发、范围、易错点或工作图验收。']),
    ''
  ];
}

function evidenceLine(arm) {
  if (!arm) return '- 未运行。';
  const evidence = arm.evidence;
  if (!evidence) return `- \`${arm.arm}\`：该臂没有可记录的客户端证据。`;
  if (evidence.transcript === null) {
    return `- \`${arm.arm}\`：确定性替身写入场景声明的文件；不调用模型，不访问外部服务。`;
  }
  const skill = evidence.skillReadExpected
    ? evidence.skillRead
      ? '实际读取了所选 Skill'
      : '没有读取所选 Skill（输出不能归因于该 Skill；可能是模型已知或条件忽略）'
    : '未提供 Skill';
  const tools = evidence.toolCalls?.length
    ? evidence.toolCalls.map(call => `${call.tool}${call.status ? `:${call.status}` : ''}${call.inputId ? `(${call.inputId})` : ''}`).join(', ')
    : '无';
  const upstream = evidence.upstreamExecution === 'confirmed'
    ? '上游执行：客户端报告了完成的模型步骤'
    : evidence.upstreamExecution === 'not_confirmed'
      ? '上游执行：没有完成的模型步骤，不能确认提供方实际执行'
      : evidence.upstreamExecution === 'not_applicable'
        ? '上游执行：不适用'
        : '上游执行：未知';
  return `- \`${arm.arm}\`：${skill}；工具调用：${cell(tools)}；`
    + `产物：${evidence.artifactFiles === 0 ? '客户端没有返回可用文件' : `客户端返回 JSON，可信评分器写入 ${evidence.artifactFiles} 个文件`}；`
    + `${evidence.providerContact ? '本臂配置为访问模型提供方' : '本臂不访问模型提供方'}；${upstream}。`
    + (evidence.skillReadExpected && evidence.skillError ? ` Skill 读取错误：${cell(evidence.skillError)}。` : '');
}

export function renderReport(result) {
  const selection = result.selection;
  const lines = [
    '# 单一 Skill 配对评测',
    '',
    `- 工作流：\`${selection.workflowId}\` 第 ${selection.version} 版（${selection.selectionId}）`,
    `- 名称：${selection.name}`,
    `- 状态：${selection.status}${selection.active ? '（当前生效）' : '（不是当前生效版本）'}；`
      + `人确认：${selection.confirmed ? `${selection.confirmedBy} @ ${selection.confirmedAt}` : '未确认'}`,
    `- 来源：\`${selection.source}\`，${selection.createdBy} 提出`,
    `- 存储：${selection.storeFile}（只读；本次使用的工作流数：${selection.usedWorkflowCount}）`,
    `- 场景：${result.setup.scenario ?? '内置 fixture'}（${result.setup.scenarioFiles.length} 个初始文件）`,
    `- 模式：${result.mode}（${result.evidenceKind}）`,
    `- 客户端：${result.setup.client.name} ${result.setup.client.version ?? '版本未知'}`,
    `- 隔离：${result.setup.isolation}`,
    '',
    result.liveClient
      ? '> 本次使用了真实 OpenCode v2 客户端，并向配置的模型提供方发送模型请求；上游是否实际执行只按逐臂步骤事件写明。它仍只证明这次运行的输出，不证明 FULI 在别处如何投递。'
      : '> 这不是真实客户端证据：确定性接缝只验证评测流程，使用内置替身，不调用模型，也不访问外部服务。',
    '',
    ...selectionContent(selection),
    '## 同一任务的两臂',
    '',
    `正面任务：\`${result.setup.positiveTask}\`；两臂任务、客户端和模型相同，各自使用全新的临时目录。`,
    '',
    '| 臂 | 任务 | 结果 | 修正 | 验收检查 | 实际改动 |',
    '| --- | --- | --- | --- | --- | --- |',
    armRow(result.arms.positiveOff),
    armRow(result.arms.positiveOn),
    '',
    `配对结果：${result.pair.effect}（off：${PASS[result.pair.offPass] ?? '未知'}，on：${PASS[result.pair.onPass] ?? '未知'}）。`,
    '',
    '## 两臂耗时与 token',
    '',
    '耗时是评测器在本机测的墙钟时间。token 只取客户端 `step_finish` 事件报告的值；没有报告就写未知，不从文本或字节估算。',
    '',
    '| 臂 | 耗时 | 输入 | 输出 | 推理 | 缓存读 | 缓存写 | token 来源 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    usageRow(result.arms.positiveOff),
    usageRow(result.arms.positiveOn),
    '',
    '## 逐臂证据',
    '',
    evidenceLine(result.arms.positiveOff),
    evidenceLine(result.arms.positiveOn),
    evidenceLine(result.arms.negativeOn),
    '',
    '## 负向对照',
    '',
    result.negativeControl.measured
      ? `任务：\`${result.setup.negativeTask}\`；Skill 读取：${YES_NO[result.negativeControl.skillRead] ?? '未知'}；`
        + `实际输出改动：${cell(result.negativeControl.outputEffect?.changedPaths?.join(', ') || '无变化')}；`
        + `误触发：${result.negativeControl.triggered ? '是' : '否'}；结果：${PASS[result.negativeControl.pass] ?? '未知'}。`
        + (result.negativeControl.triggered
          ? ` 触发证据：文件 ${result.negativeControl.triggeredBy.files.join(', ') || '无'}；`
            + `标记 ${result.negativeControl.triggeredBy.markers.join(', ') || '无'}。`
          : '')
      : `未测量：${result.negativeControl.unavailable ?? '未运行'}`,
    '',
    '## 证据与未知项',
    '',
    `- 负向对照臂：${result.arms.negativeOn ? `\`${result.arms.negativeOn.arm}\`` : '未运行'}。`,
    `- 模型：${result.arms.positiveOn?.evidence?.requestedModel
      ? `请求 \`${result.arms.positiveOn.evidence.requestedModel}\`；客户端步骤事件报告：`
        + `${result.arms.positiveOn.evidence.reportedModel
          ? `\`${result.arms.positiveOn.evidence.reportedModel}\``
          : '未报告（未知）'}。`
      : '不适用（确定性接缝）。'}`,
    `- 修正次数：${result.arms.positiveOn?.corrections?.count ?? '未知'}`
      + `${result.arms.positiveOn?.corrections?.unavailable ? `（${result.arms.positiveOn.corrections.unavailable}）` : ''}。`,
    `- 工作流存储未改变：${result.storeUnchanged === null ? '未知' : result.storeUnchanged ? '是' : '否'}。`,
    `- 结果目录：\`${result.runDirectory}\`（逐臂输出、文件和检查在 \`result.json\`）。`,
    '',
    '## 未测量或不可用',
    '',
    ...(result.unavailable.length ? result.unavailable.map(item => `- ${item}`) : ['- 无。']),
    '',
    '单次配对只说明这一次运行；要形成产品结论，需要足量、同条件、随机顺序的配对任务。',
    ''
  ];
  return lines.join('\n');
}
