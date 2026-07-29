import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';

export function shouldPromptForAgentSelection(plan, options) {
  if (options.yes || options.skipAgents || options.codexOnly) return false;
  return availableAgents(plan).length > 1;
}

export function applyAgentSelection(plan, selectedAgentIds) {
  const selected = new Set(selectedAgentIds);
  return {
    ...plan,
    agents: plan.agents.map((agent) => ({
      ...agent,
      selected: agent.available && selected.has(agent.id)
    }))
  };
}

export function parseAgentSelection(value, agents) {
  const answer = value.trim();
  if (!answer) return agents.map(({ id }) => id);
  if (answer === '0') return [];

  const tokens = answer.split(/[\s,，]+/).filter(Boolean);
  if (tokens.includes('0')) {
    throw new TypeError('0 不能与其他编号同时使用');
  }
  if (tokens.some((token) => !/^\d+$/.test(token))) {
    throw new TypeError('请输入编号，不要输入 Agent 名称');
  }

  const positions = new Set(tokens.map(Number));
  if ([...positions].some((position) => position < 1 || position > agents.length)) {
    throw new RangeError(`可选范围是 1-${agents.length}`);
  }
  return agents
    .filter((_, index) => positions.has(index + 1))
    .map(({ id }) => id);
}

export function createAgentSelectionState(agents) {
  return {
    activeIndex: 0,
    selected: agents.map(() => true)
  };
}

export function handleAgentSelectionKey(state, key) {
  if (key.ctrl && key.name === 'c') return { action: 'cancel', state };
  if (key.name === 'return' || key.name === 'enter') return { action: 'submit', state };

  if (key.name === 'up' || key.name === 'down') {
    const direction = key.name === 'up' ? -1 : 1;
    const activeIndex = (
      state.activeIndex + direction + state.selected.length
    ) % state.selected.length;
    return { action: 'update', state: { ...state, activeIndex } };
  }

  if (key.name === 'space' || key.name === ' ') {
    const selected = [...state.selected];
    selected[state.activeIndex] = !selected[state.activeIndex];
    return { action: 'update', state: { ...state, selected } };
  }

  if (key.name === 'a') {
    const nextValue = !state.selected.every(Boolean);
    return {
      action: 'update',
      state: { ...state, selected: state.selected.map(() => nextValue) }
    };
  }

  return { action: 'ignore', state };
}

export function selectedAgentIds(agents, state) {
  return agents
    .filter((_, index) => state.selected[index])
    .map(({ id }) => id);
}

export function formatAgentCheckboxSelection(agents, state) {
  return [
    '检测到多个可接入的 Agent：',
    ...agents.map((agent, index) => {
      const pointer = index === state.activeIndex ? '❯' : ' ';
      const checkbox = state.selected[index] ? '[x]' : '[ ]';
      const status = integrationStatusLabel(agent.integrationStatus);
      return `${pointer} ${checkbox} ${agent.label}${status ? `  ${status}` : ''}`;
    }),
    '↑/↓ 移动 · 空格切换 · A 全选/清空 · 回车确认'
  ].join('\n');
}

function integrationStatusLabel(status) {
  if (status === 'connected') return '已接入';
  if (status === 'update_available') return '需更新';
  if (status === 'not_connected') return '未接入';
  return '';
}

export async function promptAgentSelection(agents, {
  input = process.stdin,
  output = process.stdout
} = {}) {
  if (supportsCheckboxSelection(input, output)) {
    return promptCheckboxAgentSelection(agents, { input, output });
  }
  return promptTextAgentSelection(agents, { input, output });
}

async function promptCheckboxAgentSelection(agents, { input, output }) {
  let state = createAgentSelectionState(agents);
  const lineCount = agents.length + 2;
  const wasPaused = typeof input.isPaused === 'function' && input.isPaused();
  const wasRaw = input.isRaw === true;
  emitKeypressEvents(input);
  if (!wasRaw) input.setRawMode(true);
  input.resume();
  output.write(HIDE_CURSOR);
  output.write(formatAgentCheckboxSelection(agents, state));

  return new Promise((resolve, reject) => {
    const finish = (callback) => {
      input.off('keypress', onKeypress);
      if (!wasRaw) input.setRawMode(false);
      if (wasPaused) input.pause();
      output.write(`${SHOW_CURSOR}\n`);
      callback();
    };
    const redraw = () => {
      output.write(`\r\u001B[${lineCount - 1}A\u001B[J`);
      output.write(formatAgentCheckboxSelection(agents, state));
    };
    const onKeypress = (character, key = {}) => {
      const result = handleAgentSelectionKey(state, {
        ...key,
        name: key.name ?? character
      });
      if (result.action === 'submit') {
        finish(() => resolve(selectedAgentIds(agents, state)));
        return;
      }
      if (result.action === 'cancel') {
        finish(() => reject(new Error('Setup 已取消')));
        return;
      }
      if (result.action === 'update') {
        state = result.state;
        redraw();
      }
    };
    input.on('keypress', onKeypress);
  });
}

async function promptTextAgentSelection(agents, { input, output }) {
  const terminal = createInterface({ input, output });
  output.write('检测到多个可接入的 Agent：\n');
  for (const [index, agent] of agents.entries()) {
    output.write(`  ${index + 1}. ${agent.label}\n`);
  }

  try {
    while (true) {
      const answer = await terminal.question(
        '选择要接入的 Agent（编号以逗号分隔，回车全选，0 跳过）[全部] '
      );
      try {
        return parseAgentSelection(answer, agents);
      } catch (error) {
        output.write(`选择无效：${error.message}\n`);
      }
    }
  } finally {
    terminal.close();
  }
}

function supportsCheckboxSelection(input, output) {
  return Boolean(
    input.isTTY &&
    output.isTTY &&
    typeof input.setRawMode === 'function'
  );
}

function availableAgents(plan) {
  return plan.agents.filter(({ available }) => available);
}
