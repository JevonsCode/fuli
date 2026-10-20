import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { agentAppRoot, createAgentAppService } from '../agent-apps/service.js';
import { listAgentTools } from '../agent-tools.js';
import { resolveGraphRuntimeOptions } from '../graphiti/runtime-config.js';
import { confirmInTerminal, writeLine } from './terminal-io.js';

const USAGE = 'Usage: fl app list [--agent AGENT_ID] | show APP_ID | approve APP_ID VERSION | disable APP_ID | '
  + 'rollback APP_ID VERSION | delete APP_ID [--data [--output DIR]] | export APP_ID --output DIR  [--runtime-config FILE]';
// Decisions that activate or remove Agent-written code ask at an interactive
// terminal. That keeps piped callers from answering for the user, but a process
// of this OS account can open a terminal too, so it does not show a person
// decided: FULI records entrypoint cli with presence unverified.
const INTERACTIVE_ACTIONS = new Set(['approve', 'rollback', 'delete']);

// Local user management of Agent apps. Normal Agent tools only submit and read;
// approval, rollback and removal come through this command or the local console.
export async function runAppCommand(args, {
  env = process.env, interactive = process.stdin.isTTY === true, confirm = confirmInTerminal, print = writeLine
} = {}) {
  const { values, positionals: [action, appId, version] } = parseAppArguments(args);
  if (!Object.hasOwn(ACTIONS, action ?? '') || (action !== 'list' && !appId)) throw new TypeError(USAGE);
  if (INTERACTIVE_ACTIONS.has(action) && !interactive) {
    throw new TypeError(`fl app ${action} asks the local user to confirm, so run it in an interactive terminal`);
  }
  const { runtimeConfigPath } = resolveGraphRuntimeOptions(
    values['runtime-config'] ? ['--runtime-config', values['runtime-config']] : [], env);
  const service = createAgentAppService({
    root: agentAppRoot(runtimeConfigPath), toolNames: () => listAgentTools().map(({ name }) => name)
  });
  try {
    return await ACTIONS[action]({ service, appId, version, values, confirm, print });
  } finally {
    service.close();
  }
}

const ACTIONS = Object.freeze({
  list: ({ service, values, print }) => printed(print, service.list({ agentId: values.agent ?? null })),
  show: ({ service, appId, print }) => printed(print, service.read({ appId })),
  approve: async ({ service, appId, version, confirm, print }) => {
    const detail = service.read({ appId });
    const candidate = requiredVersion(detail, version);
    if (!await confirm(approvalPreview(detail, candidate), { defaultYes: false })) return printed(print, { approved: false });
    return activateConfirmed({ confirm, print }, (confirmations) => service.approve({
      appId, version, digest: candidate.digest, approver: localUser(), ...confirmations
    }));
  },
  rollback: async ({ service, appId, version, confirm, print }) => {
    const detail = service.read({ appId });
    const target = requiredVersion(detail, version);
    const question = `Activate approved version ${version} of ${appId} (${target.title}, digest ${target.digest})? [y/N] `;
    if (!await confirm(question, { defaultYes: false })) return printed(print, { activated: false });
    return activateConfirmed({ confirm, print }, (confirmations) => service.rollback({
      appId, version, actor: localUser(), ...confirmations
    }));
  },
  disable: ({ service, appId, print }) => printed(print, service.disable({ appId, actor: localUser() })),
  delete: ({ service, appId, values, confirm, print }) => (values.data
    ? deleteData({ service, appId, values, confirm, print })
    : deleteCode({ service, appId, confirm, print })),
  export: ({ service, appId, values, print }) => {
    if (!values.output) throw new TypeError(USAGE);
    return printed(print, service.exportData({ appId, destination: resolve(values.output) }));
  }
});

// The package approval comes first; a resident service and an irreversible data
// migration each need their own answer before the version is activated.
async function activateConfirmed({ confirm, print }, activate) {
  const confirmations = {};
  for (;;) {
    try {
      return printed(print, activate(confirmations));
    } catch (error) {
      const followUp = FOLLOW_UPS[error?.code];
      if (!followUp || confirmations[followUp.field]) throw error;
      if (!await confirm(`${error.message}. ${followUp.question} [y/N] `, { defaultYes: false })) {
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
  return printed(print, service.deleteCode({ appId, actor: localUser() }));
}

async function deleteData({ service, appId, values, confirm, print }) {
  const offer = service.prepareDataDeletion({ appId });
  print(`${appId} keeps ${offer.dataFiles} data files (${offer.dataBytes} bytes). ${offer.warning}`);
  if (values.output) printed(print, service.exportData({ appId, destination: resolve(values.output) }));
  else if (await confirm('Export the data before deleting it? [Y/n] ', { defaultYes: true })) {
    print(`Export first with: ${offer.export}`);
    return { deleted: false };
  }
  if (!await confirm(`Permanently delete all data of ${appId}? This cannot be undone. [y/N] `, { defaultYes: false })) {
    return printed(print, { deleted: false });
  }
  return printed(print, service.deleteData({ appId, ticket: offer.ticket, confirm: offer.confirm, actor: localUser() }));
}

function approvalPreview(detail, version) {
  const data = version.data.scope === 'app'
    ? `own data directory, format ${version.data.format} (opens ${version.data.accepts.join(', ')})` : 'none';
  return [
    `Approve Agent app ${detail.appId}: ${detail.name} by Agent ${detail.agentId}`,
    `  version      ${version.version} — ${version.title}`,
    `  type         ${version.type}`,
    `  digest       ${version.digest}`,
    `  permissions  ${version.permissions.join(', ') || 'none'}`,
    `  data         ${data}`,
    `  resident     ${version.resident ? 'yes, keeps running in the background' : 'no'}`,
    `  files        ${version.files} (${version.bytes} bytes)`,
    'The approval covers only this exact package. FULI has no app runner yet, so no app code runs now.',
    'Recorded as entrypoint cli, presence unverified. Approve it? [y/N] '
  ].join('\n');
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
      agent: { type: 'string' }, data: { type: 'boolean' }, output: { type: 'string' },
      'runtime-config': { type: 'string' }
    } });
  } catch (error) {
    throw new TypeError(`${error.message}\n${USAGE}`);
  }
}
