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
    throw new TypeError('0 cannot be combined with another number');
  }
  if (tokens.some((token) => !/^\d+$/.test(token))) {
    throw new TypeError('Enter numbers, not Agent names');
  }

  const positions = new Set(tokens.map(Number));
  if ([...positions].some((position) => position < 1 || position > agents.length)) {
    throw new RangeError(`Choose a number from 1-${agents.length}`);
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
    'Multiple supported Agents were detected:',
    ...agents.map((agent, index) => {
      const pointer = index === state.activeIndex ? '❯' : ' ';
      const checkbox = state.selected[index] ? '[x]' : '[ ]';
      const status = integrationStatusLabel(agent.integrationStatus);
      return `${pointer} ${checkbox} ${agent.label}${status ? `  ${status}` : ''}`;
    }),
    '↑/↓ Move · Space Toggle · A Select/Clear all · Enter Confirm'
  ].join('\n');
}

function integrationStatusLabel(status) {
  if (status === 'connected') return 'connected';
  if (status === 'update_available') return 'update available';
  if (status === 'not_connected') return 'not connected';
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
        finish(() => reject(new Error('Setup cancelled')));
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
  output.write('Multiple supported Agents were detected:\n');
  for (const [index, agent] of agents.entries()) {
    output.write(`  ${index + 1}. ${agent.label}\n`);
  }

  try {
    while (true) {
      const answer = await terminal.question(
        'Select Agents (comma-separated numbers, Enter for all, 0 to skip) [all] '
      );
      try {
        return parseAgentSelection(answer, agents);
      } catch (error) {
        output.write(`Invalid selection: ${error.message}\n`);
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
