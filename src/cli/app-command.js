import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { createConfirmedDecisions } from '../agent-apps/confirmed-decisions.js';
import { agentAppContext, agentAppRoot, agentAppServiceOver } from '../agent-apps/service.js';
import { listAgentTools } from '../agent-tools.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { presencePort } from '../presence/port.js';
import { confirmInTerminal, typedLineInTerminal, writeLine } from './terminal-io.js';

const USAGE = 'Usage: fl app list [--agent AGENT_ID] | show APP_ID | approve APP_ID VERSION [--hello] | disable APP_ID | '
  + 'rollback APP_ID VERSION [--hello] | stop APP_ID [--force] | delete APP_ID [--data [--output DIR]] | export APP_ID --output DIR  '
  + '[--runtime-config FILE]';
// Decisions that activate or remove Agent-written code ask at an interactive
// terminal. That keeps piped callers from answering for the user, but a process
// of this OS account can open a terminal too, so it does not show a person
// decided. Approve and rollback complete the terminal confirmation flow
// (confirmed-decisions.js, rec#11 D-36.9); delete records entrypoint cli with
// presence unverified.
const INTERACTIVE_ACTIONS = new Set(['approve', 'rollback', 'delete']);

// Local user management of Agent apps. Normal Agent tools only submit and read;
// approval, rollback and removal come through this command or the local console.
// confirm, typeLine, platform and presence are seams for tests; a real run
// uses this terminal and, with --hello, this computer's Windows Hello.
export async function runAppCommand(args, {
  env = process.env, interactive = process.stdin.isTTY === true, confirm = confirmInTerminal, typeLine = typedLineInTerminal,
  print = writeLine, platform = process.platform, presence
} = {}) {
  const { values, positionals: [action, appId, version] } = parseAppArguments(args);
  if (!Object.hasOwn(ACTIONS, action ?? '') || (action !== 'list' && !appId)) throw new TypeError(USAGE);
  if (INTERACTIVE_ACTIONS.has(action) && !interactive) {
    throw new TypeError(`fl app ${action} asks the local user to confirm, so run it in an interactive terminal`);
  }
  const hello = values.hello ? presence ?? presencePort({ platform }) : null;
  if (hello && !hello.kind) throw new TypeError('--hello uses Windows Hello, which this platform does not have');
  const { runtimeConfigPath } = resolveGraphRuntimeOptions(
    values['runtime-config'] ? ['--runtime-config', values['runtime-config']] : [], env);
  const context = agentAppContext({
    root: agentAppRoot(runtimeConfigPath), toolNames: () => listAgentTools().map(({ name }) => name), ownerKind: 'cli'
  });
  const service = agentAppServiceOver(context);
  const decisions = createConfirmedDecisions(context, { confirmation: terminalConfirmation({ print, typeLine }), presence: hello });
  try {
    return await ACTIONS[action]({ service, decisions, appId, version, values, confirm, print });
  } finally {
    service.close();
  }
}

// Shows what the challenge binds (the app name, its terms, the trusted-mode
// warning) and reads the app name typed back.
function terminalConfirmation({ print, typeLine }) {
  return {
    ask: async ({ message, appName }) => {
      print(message);
      return typeLine(`Type the app name ${appName} to confirm, or press Enter to cancel `
        + `(输入应用名 ${appName} 确认，直接回车取消): `);
    }
  };
}

const ACTIONS = Object.freeze({
  list: ({ service, values, print }) => printed(print, service.list({ agentId: values.agent ?? null })),
  show: ({ service, appId, print }) => printed(print, service.read({ appId })),
  approve: ({ service, decisions, appId, version, confirm, print }) => {
    const candidate = requiredVersion(service.read({ appId }), version);
    return activateConfirmed({ service, confirm, print, label: `${appId} ${version}` }, (confirmations) => decisions.approve({
      appId, version, digest: candidate.digest, approver: localUser(), ...confirmations
    }));
  },
  rollback: ({ service, decisions, appId, version, confirm, print }) => {
    requiredVersion(service.read({ appId }), version);
    return activateConfirmed({ service, confirm, print, label: `${appId} ${version}` }, (confirmations) => decisions.rollback({
      appId, version, actor: localUser(), ...confirmations
    }));
  },
  disable: async ({ service, appId, print }) => printed(print, await service.disable({ appId, actor: localUser() })),
  // --force against a live FULI process holding the app is refused on every
  // platform and nothing is signalled (rec#7 D-28.29, rec#11 D-36.3).
  stop: async ({ service, appId, values, print }) => printed(print, await service.stop({ appId, force: values.force === true })),
  delete: ({ service, appId, values, confirm, print }) => (values.data
    ? deleteData({ service, appId, values, confirm, print })
    : deleteCode({ service, appId, confirm, print })),
  export: async ({ service, appId, values, print }) => {
    if (!values.output) throw new TypeError(USAGE);
    return printed(print, await service.exportData({ appId, destination: resolve(values.output) }));
  }
});

// A resident service and an irreversible data migration each need their own
// answer, all before the one terminal confirmation that covers them. The
// result says what the run gate answers now.
async function activateConfirmed({ service, confirm, print, label }, activate) {
  const confirmations = {};
  for (;;) {
    try {
      const activated = await activate(confirmations);
      return printed(print, { ...activated, run: service.read({ appId: activated.appId }).run });
    } catch (error) {
      const followUp = FOLLOW_UPS[error?.code];
      if (!followUp || confirmations[followUp.field]) throw error;
      if (!await confirm(`${label}: ${error.message}. ${followUp.question} [y/N] `, { defaultYes: false })) {
        return printed(print, { activated: false });
      }
      confirmations[followUp.field] = true;
    }
  }
}

const FOLLOW_UPS = Object.freeze({
  resident_confirmation_required: { field: 'confirmResident',
    question: 'Allow this resident service to keep running in the background?' },
  migration_confirmation_required: { field: 'confirmIrreversibleMigration',
    question: 'Convert the app data? Rolling back code will not restore the earlier format.' }
});

async function deleteCode({ service, appId, confirm, print }) {
  const question = `Delete the code and pages of ${appId}? Its data is kept and the app can be restored. [y/N] `;
  if (!await confirm(question, { defaultYes: false })) return printed(print, { deleted: false });
  return printed(print, await service.deleteCode({ appId, actor: localUser() }));
}

async function deleteData({ service, appId, values, confirm, print }) {
  const offer = await service.prepareDataDeletion({ appId });
  print(`${appId} keeps ${offer.dataFiles} data files (${offer.dataBytes} bytes). ${offer.warning}`);
  if (values.output) printed(print, await service.exportData({ appId, destination: resolve(values.output) }));
  else if (await confirm('Export the data before deleting it? [Y/n] ', { defaultYes: true })) {
    print(`Export first with: ${offer.export}`);
    return { deleted: false };
  }
  if (!await confirm(`Permanently delete all data of ${appId}? This cannot be undone. [y/N] `, { defaultYes: false })) {
    return printed(print, { deleted: false });
  }
  return printed(print, await service.deleteData({ appId, ticket: offer.ticket, confirm: offer.confirm, actor: localUser() }));
}

function requiredVersion(detail, version) {
  const found = detail.versions.find((entry) => entry.version === version);
  if (!found) throw new TypeError(`${detail.appId} has no version ${version ?? ''}`.trim());
  return found;
}

function localUser() {
  try {
    return { entrypoint: 'cli', user: userInfo().username };
  } catch {
    return { entrypoint: 'cli', user: 'local-user' };
  }
}

function printed(print, result) {
  print(JSON.stringify(result));
  return result;
}

function parseAppArguments(args) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options: {
      agent: { type: 'string' }, data: { type: 'boolean' }, force: { type: 'boolean' }, hello: { type: 'boolean' },
      output: { type: 'string' }, 'runtime-config': { type: 'string' }
    } });
  } catch (error) {
    throw new TypeError(`${error.message}\n${USAGE}`);
  }
}
