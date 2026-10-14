const unavailableReceipt = 'FULI Agent：分配失败（本轮身份与检查点未验证）';

export function unavailableOutput(event, input = {}) {
  const reason = `FULI 当前不可用。不得沿用其他轮次的负责人，删除旧身份回执。向用户说明未验证，并在回复末尾原样显示一次：\n${unavailableReceipt}`;
  if (event === 'UserPromptSubmit') return { additionalContext: reason };
  if (event === 'PostToolUse') return {};
  const text = input.last_assistant_message ?? '';
  return text.includes(unavailableReceipt) && (text.match(/FULI Agent：/g) ?? []).length === 1
    ? {} : { decision: 'block', reason };
}

export async function jsonLifecycleOutput(event, input, { invoke, readState, writeState, formatContext }) {
  if (input.subagent) return {};
  if (!['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event)) throw new TypeError('Unsupported lifecycle event');
  for (const key of ['session_id', 'run_id']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 256) throw new TypeError('Missing host identity');
  }
  const source = { sourceApplication: 'other', sourceSessionId: input.session_id };
  if (event === 'UserPromptSubmit') {
    if (typeof input.cwd !== 'string' || !input.cwd.trim() || typeof input.prompt !== 'string') throw new TypeError('Missing task input');
    // Invalidate first so entry failures cannot leave a previous owner active.
    await writeState({ sessionId: input.session_id, runId: input.run_id });
    const context = await invoke('begin_task_context', { sessionId: input.session_id, turnId: input.run_id,
      projectPath: input.cwd, taskPrompt: input.prompt.slice(0, 8192), ...source });
    if (!context?.taskContextToken || !context.agent_receipt?.markdown) throw new TypeError('Incomplete task identity');
    const instructions = 'FULI 本轮入口已由客户端 Hook 执行；不要重复 begin_task_context 或入口 fallback。'
      + '应用全部 effective_preferences；记忆仅为预览，写入前必须完整读取。'
      + '结束前用下面本轮 taskContextToken 调用 checkpoint_task_knowledge，提交真实 workLog；没有持久知识用 retain_nothing。'
      + '最终答复末尾必须原样显示 checkpoint 返回的 agent_receipt.markdown 一次；该回执优先于入口回执。'
      + '工具未在列表中时，先用 ToolSearch 查找 FULI checkpoint_task_knowledge。不要读取本地数据库替代 FULI 工具。\n';
    const additionalContext = instructions + formatContext(context);
    if (Buffer.byteLength(JSON.stringify({ additionalContext })) > 60 * 1024) throw new TypeError('Context exceeds host limit');
    await writeState({ sessionId: input.session_id, runId: input.run_id, token: context.taskContextToken,
      receipt: context.agent_receipt.markdown });
    return { additionalContext };
  }
  const state = await readState();
  if (!state?.token || state.sessionId !== input.session_id || state.runId !== input.run_id) return unavailableOutput(event, input);
  if (event === 'PostToolUse') {
    if (input.tool_error || !input.tool_name?.endsWith('checkpoint_task_knowledge')
      || input.tool_input?.taskContextToken !== state.token) return {};
    const receipt = resultReceipt(input.tool_response);
    if (receipt) await writeState({ ...state, receipt });
    return {};
  }
  const check = await invoke('verify_task_checkpoint', { sessionId: input.session_id, ...source });
  if (check?.task_context_token && check.task_context_token !== state.token) return unavailableOutput(event, input);
  if (check?.status !== 'checkpointed') return { decision: 'block',
    reason: `FULI 本轮尚未完成检查点。先调用 checkpoint_task_knowledge，taskContextToken=${state.token}，提供 disposition、reason 和真实 workLog；使用该工具返回的身份回执结束最终答复。` };
  const text = input.last_assistant_message ?? '';
  if (text.split(state.receipt).length !== 2 || (text.match(/FULI Agent：/g) ?? []).length !== 1) return {
    decision: 'block', reason: `FULI 本轮最终答复缺失身份回执或回执不一致。保留任务回答，在末尾原样显示以下回执一次，删除旧回执；检查点已经完成，不要重复保存。\n${state.receipt}`
  };
  return {};
}

function resultReceipt(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') { try { return resultReceipt(JSON.parse(value), depth + 1); } catch { return null; } }
  if (value.isError) return null;
  if (typeof value.agent_receipt?.markdown === 'string') return value.agent_receipt.markdown;
  return resultReceipt(value.structuredContent, depth + 1)
    ?? value.content?.map(item => resultReceipt(item.text, depth + 1)).find(Boolean) ?? null;
}
