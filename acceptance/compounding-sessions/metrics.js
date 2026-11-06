// One headless Claude Code session's measurements from its stream-json events (`--output-format stream-json
// --verbose --include-hook-events`). Usage and cost come from the final `result` event; tool calls are split into
// exploration (reading and searching the repo), edits, runs (tests and project commands), FULI calls and the rest.
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');

const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EXPLORE_COMMAND = /^\s*(cat|ls|head|tail|grep|rg|find|tree|wc|sed -n|git (log|show|diff|status))\b/;

export function toolKind(tool) {
  if (tool.name.startsWith('mcp__fuli__')) return 'fuli';
  if (EXPLORE_TOOLS.has(tool.name)) return 'explore';
  if (EDIT_TOOLS.has(tool.name)) return 'edit';
  if (tool.name === 'Bash') return EXPLORE_COMMAND.test(String(tool.input?.command ?? '')) ? 'explore' : 'run';
  return 'other';
}

function hookContext(event) {
  try {
    return JSON.parse(event.stdout ?? event.output ?? '{}')?.hookSpecificOutput?.additionalContext ?? '';
  } catch {
    return '';
  }
}

export function sessionReport(events) {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = events.findLast((e) => e.type === 'result');
  const toolUses = events.filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use'));
  const toolResults = new Map(events.filter((e) => e.type === 'user')
    .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((c) => c.type === 'tool_result').map((c) => [c.tool_use_id, c]));
  const hooks = events.filter((e) => e.type === 'system' && e.subtype === 'hook_response');
  const hookEvent = (name) => hooks.filter((e) => (e.hook_event ?? e.hook_event_name) === name);
  const kinds = { explore: 0, edit: 0, run: 0, fuli: 0, other: 0 };
  for (const tool of toolUses) kinds[toolKind(tool)] += 1;
  const fuliUses = toolUses.filter((t) => t.name.startsWith('mcp__fuli__'));
  const u = result?.usage ?? {};
  const allInput = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].every(Number.isFinite)
    ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : null;
  return {
    sessionId: result?.session_id ?? init?.session_id ?? null,
    model: init?.model ?? null,
    mcpServers: (init?.mcp_servers ?? []).map((s) => s.name),
    resultSubtype: result?.subtype ?? null,
    isError: result?.is_error ?? null,
    numTurns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    modelUsage: result?.modelUsage ?? null,
    text: String(result?.result ?? '').slice(0, 800),
    usage: { input: u.input_tokens ?? null, cacheRead: u.cache_read_input_tokens ?? null,
      cacheWrite: u.cache_creation_input_tokens ?? null, output: u.output_tokens ?? null, allInput },
    modelRequests: new Set(events.filter((e) => e.type === 'assistant').map((e) => e.message?.id)).size,
    tools: { total: toolUses.length, ...kinds,
      failedRuns: toolUses.filter((t) => toolKind(t) === 'run' && toolResults.get(t.id)?.is_error).length },
    toolSequence: toolUses.map((t) => (t.name === 'Bash' ? `Bash:${String(t.input?.command ?? '').slice(0, 60)}` : t.name)),
    fuli: {
      calls: fuliUses.map((t) => t.name.replace('mcp__fuli__', '')),
      outputBytes: fuliUses.reduce((sum, t) => sum + bytes(toolResults.get(t.id)?.content), 0),
      failed: fuliUses.filter((t) => toolResults.get(t.id)?.is_error).length,
      checkpoints: fuliUses.filter((t) => t.name === 'mcp__fuli__checkpoint_task_knowledge')
        .map((t) => JSON.stringify(t.input ?? {}).slice(0, 1500))
    },
    hooks: {
      promptContextBytes: hookEvent('UserPromptSubmit').reduce((sum, e) => sum + bytes(hookContext(e)), 0),
      sessionStartBytes: hookEvent('SessionStart').reduce((sum, e) => sum + bytes(hookContext(e)), 0),
      stopBlocks: hookEvent('Stop').filter((e) => {
        try { return JSON.parse(e.stdout ?? '{}').decision === 'block'; } catch { return false; }
      }).length,
      failed: hooks.filter((e) => e.outcome && e.outcome !== 'success').length
    }
  };
}
