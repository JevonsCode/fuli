#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPeerRuntime } from '../packages/roundtable/src/peer/peer-runtime.js';
import { handleApiRequest } from './http/api-router.js';
import { mapHttpError } from './http/error-mapping.js';
import { isCrossSiteNavigation, localServerAuthority, rejectRequestOutsidePolicy } from './http/request-policy.js';
import { sendJson } from './http/response.js';
import { closeTaskEventStreams } from './http/task-events-api-router.js';
import { serveStatic } from './http/static-handler.js';
import { isMainModule } from './system/main-module.js';
import { DEFAULT_FULI_PORT } from './defaults.js';
import { resolveGraphRuntimeOptions } from './graphiti/runtime-config.js';
import { isFetchBlockedPort } from './server/blocked-ports.js';
import {
  discoverLanAddresses,
  lanConsoleUrls,
  lanServerAuthorities
} from './server/lan-access.js';
import { createServerApplication } from './server/application-lifecycle.js';
import { createWorkerPlanRuntime } from './server/worker-plan-runtime.js';
import { listenFetchableServer } from './server/listen.js';
import { resolveSetupPaths } from './setup/paths.js';
import { createSystemService } from './system/system-service.js';
import { startJudgmentScheduler } from './judgment/scheduler.js';
import { dataFormatNoticeLine, dataFormatNotices, latestNotices } from './data-format/format-notices.js';
import { personalGraphFormat } from './data-format/graph-format-client.js';
import { holdDataDirectory } from './data-format/maintenance-lock.js';
import { dataFormatMigrations as createDataFormatMigrations } from './data-format/migration-operations.js';
import { consoleRestore } from './data-format/console-restore.js';
import { knowledgeHardDelete as createKnowledgeHardDelete } from './knowledge-hard-delete/console-port.js';
import { createKnowledgeRecoveryCheck } from './knowledge-hard-delete/recovery-check.js';
import { knowledgeScopeConsole as createKnowledgeScopeConsole } from './knowledge-scope/console-port.js';
import { projectHierarchyConsole as createProjectHierarchyConsole } from './project-hierarchy/console-port.js';
import { taskBlockerConsole as createTaskBlockerConsole } from './task-blockers/console-port.js';
import { knowledgeOwnerReads as createKnowledgeOwnerReads } from './knowledge-owner-reads/console-port.js';
import { reviewUndoConsole } from './judgment/review-undo.js';
import { knowledgeTagsConsole as createKnowledgeTagsConsole } from './knowledge-tags/console-port.js';
import { createModelRoleSettings } from './model-backends/role-settings.js';
import { createModelSecretStore } from './model-backends/secret-store.js';
import { latestEvaluation } from './model-backends/evaluation-record.js';
import { createClientLinksRegistry } from './client-links/registry.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function createServer(options = {}) {
  const {
    port = DEFAULT_FULI_PORT,
    app,
    closeApplicationOnShutdown,
    isBlockedPort = isFetchBlockedPort,
    lan = false,
    lanAccessToken = null,
    lanAddresses: configuredLanAddresses = null
  } = options;
  const lanEnabled = lan === true;
  const lanToken = lanEnabled ? requiredLanToken(lanAccessToken) : null;
  const lanAddresses = lanEnabled
    ? [...new Set(configuredLanAddresses ?? discoverLanAddresses())]
    : [];
  if (lanEnabled && lanAddresses.length === 0) {
    throw new Error('No private IPv4 LAN address is available');
  }
  if (Number(port) !== 0 && isBlockedPort(port)) {
    throw new Error(`Port ${port} is blocked for local fetch`);
  }
  const localOptions = app ? {} : resolveServerGraphOptions(options);
  // A whole-store restore (fuli migrate restore) excludes a running console
  // and the console excludes it; refused here before any store is opened.
  const releaseDataDirectory = localOptions.runtimeConfigPath
    ? holdDataDirectory(dirname(localOptions.runtimeConfigPath)) : () => {};
  let runtime;
  try {
    runtime = createServerApplication({
      app,
      ...localOptions,
      closeApplicationOnShutdown
    });
  } catch (error) {
    releaseDataDirectory();
    throw error;
  }
  const application = runtime.application;
  // The console, not every hook or MCP process, reports the local stores this
  // FULI cannot use as they are, named with their steps (rec#17).
  // /api/health answers them without waiting on a store (latestNotices).
  const formatNotices = options.dataFormatNotices ?? (localOptions.runtimeConfigPath
    ? dataFormatNotices(dirname(localOptions.runtimeConfigPath)) : null);
  const dataFormats = formatNotices ? latestNotices(formatNotices) : null;
  for (const notice of dataFormats?.() ?? []) console.warn(dataFormatNoticeLine(notice));
  // A person's confirmed migrations, the same operations as `fuli migrate`.
  const dataFormatMigrations = options.dataFormatMigrations ?? (localOptions.runtimeConfigPath
    ? createDataFormatMigrations(dirname(localOptions.runtimeConfigPath),
      { graph: personalGraphFormat(dirname(localOptions.runtimeConfigPath)),
        restore: consoleRestore(dirname(localOptions.runtimeConfigPath)) }) : null);
  for (const pruned of dataFormatMigrations?.prune() ?? []) {
    if (pruned.kind === 'prune_failed') console.warn(`Format backups were not pruned: ${pruned.reason}`);
  }
  // A person's 「彻底删除」 of one knowledge item (rec#5 C9), console only.
  const knowledgeHardDelete = options.knowledgeHardDelete ?? (localOptions.runtimeConfigPath
    ? createKnowledgeHardDelete(dirname(localOptions.runtimeConfigPath),
      { personalSpaceId: () => application.config?.personal?.spaceId ?? null,
        agentSnapshots: application.agentSnapshots,
        reconcileSubmissions: () => application.reconcilePersonalSubmissions({}, knowledgeOwnerReads) }) : null);
  // A person's change of where knowledge applies (rec#20, rec#11 D-22), console only.
  const knowledgeScope = options.knowledgeScope ?? (localOptions.runtimeConfigPath
    ? createKnowledgeScopeConsole(dirname(localOptions.runtimeConfigPath)) : null);
  // A person's move of a project in their hierarchy (调整层级), console only.
  const projectHierarchy = options.projectHierarchy ?? (localOptions.runtimeConfigPath
    ? createProjectHierarchyConsole(dirname(localOptions.runtimeConfigPath)) : null);
  // A person's 「标记为已解除」 of a blocked task, console only.
  const taskBlockers = options.taskBlockers ?? (localOptions.runtimeConfigPath
    ? createTaskBlockerConsole(dirname(localOptions.runtimeConfigPath)) : null);
  // The person's full knowledge reads, every FLA's included (console only).
  const knowledgeOwnerReads = options.knowledgeOwnerReads ?? (localOptions.runtimeConfigPath
    ? createKnowledgeOwnerReads(dirname(localOptions.runtimeConfigPath)) : null);
  // The person's undo of Tonborg's automatic knowledge review (rec#10 D-24), console only.
  const judgmentUndo = options.judgmentUndo ?? (localOptions.runtimeConfigPath
    ? reviewUndoConsole(dirname(localOptions.runtimeConfigPath)) : null);
  // The person's own tag changes and tag governance (rec#11 D-07 part 2), console only.
  const knowledgeTags = options.knowledgeTags ?? (localOptions.runtimeConfigPath
    ? createKnowledgeTagsConsole(dirname(localOptions.runtimeConfigPath)) : null);
  // Saves a built-in Agent's model settings, recording what changed; reached only by the loopback route.
  const modelRoleSettings = options.modelRoleSettings ?? (localOptions.runtimeConfigPath
    ? createModelRoleSettings(resolveSetupPaths({ dataDir: dirname(localOptions.runtimeConfigPath) }).modelBackendConfigPath,
      { history: application.modelSettingsHistory }) : null);
  // The model keys the settings page saves, where `fuli models set-key` saves them; reached only by the loopback route.
  const modelSecrets = options.modelSecrets ?? (localOptions.runtimeConfigPath
    ? createModelSecretStore({ path: resolveSetupPaths({ dataDir: dirname(localOptions.runtimeConfigPath) }).modelSecretStorePath })
    : null);
  // The latest local evaluation of a role's model, as the model settings page shows it (rec#10 D-36.6).
  const readModelEvaluation = options.readModelEvaluation ?? (localOptions.runtimeConfigPath
    ? key => latestEvaluation(resolveSetupPaths({ dataDir: dirname(localOptions.runtimeConfigPath) }).modelEvaluationsPath, key) : null);
  // A delete whose answer was lost, or whose local cleanup a crash cut short,
  // is settled from its recorded operation, and graph deletions the record
  // lost are taken in again; what the graph cannot answer yet stays open for
  // the page's retry. A damaged record is reported here and on every use.
  // The client link manifest: bundled, updated by the person or once a day when they turned that on.
  const clientLinks = options.clientLinks ?? (localOptions.runtimeConfigPath
    ? createClientLinksRegistry({ statePath: resolveSetupPaths({ dataDir: dirname(localOptions.runtimeConfigPath) }).clientLinksPath })
    : null);
  knowledgeHardDelete?.reconcile().catch((error) => {
    console.warn(`Permanent deletes were not reconciled: ${error?.message ?? error}`);
  });
  let externalKnowledge;
  let connectedKnowledge;
  let system = null;
  let resourcesClosing = null;
  let stopJudgment = () => {};
  let stopClientLinkUpdates = () => {};
  let peer = null;
  let workerRuntime = null;
  function closeResources() {
    resourcesClosing ??= (async () => {
      const failures = [];
      for (const close of [() => stopJudgment(), () => stopClientLinkUpdates(), () => peer?.close(), () => workerRuntime?.close(), () => system?.close?.(), () => runtime.close(),
        () => releaseDataDirectory()]) {
        try {
          const pending = close();
          if (pending?.then) await pending;
        } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Server resource shutdown failed');
      }
    })();
    return resourcesClosing;
  }
  async function failStartup(error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Server startup failed: ${error.message}; resource shutdown also failed`, { cause: error });
    }
    throw error;
  }
  try {
    externalKnowledge = options.externalKnowledge ?? application.externalKnowledge ?? null;
    connectedKnowledge = options.connectedKnowledge ?? application.connectedKnowledge ?? null;
    system = options.system ?? (!app
      ? createSystemService({
          paths: resolveSetupPaths({
            dataDir: dirname(localOptions.runtimeConfigPath),
            packageRoot: PACKAGE_ROOT
          }),
          packageRoot: PACKAGE_ROOT,
          runtimeConfigPath: localOptions.runtimeConfigPath,
          activePort: port,
          activeLan: lanEnabled,
          executorAdapters: options.executorAdapters,
          previewDataFormats: dataFormatMigrations ? () => dataFormatMigrations.preview() : null
        })
      : null);
    if (options.workerRuntimeBindings !== undefined) {
      workerRuntime = await createWorkerPlanRuntime({
        runtimeConfigPath: options.runtimeConfigPath ?? localOptions.runtimeConfigPath,
        workerRuntimeBindings: options.workerRuntimeBindings, provider: application.personal,
        leases: options.workerRuntimeLeases, env: options.env ?? process.env
      });
    }
  } catch (error) {
    // The owned application can already hold local databases before system
    // construction or configuration validation fails, even without a listener.
    await failStartup(error);
  }
  // A request that finds deletion recovery pending starts the console's own
  // re-check, the same reconciliation it ran when it started.
  const knowledgeRecovery = knowledgeHardDelete && application.knowledgeRecoveryGate
    ? createKnowledgeRecoveryCheck({ reconcile: () => knowledgeHardDelete.reconcile(),
      gate: application.knowledgeRecoveryGate, spaceId: () => application.config?.personal?.spaceId ?? null,
      ...(system?.withGraphRuntimeLease ? { run: (work) => system.withGraphRuntimeLease('knowledge-recovery', work) } : {}) })
    : null;
  let authority = null;
  let allowedLanAuthorities = [];
  const server = createHttpServer((request, response) => {
    handleRequest({
      request,
      response,
      app: application,
      system,
      externalKnowledge,
      connectedKnowledge,
      peer,
      dataFormats,
      dataFormatMigrations,
      knowledgeHardDelete,
      knowledgeScope,
      projectHierarchy,
      taskBlockers,
      knowledgeOwnerReads,
      knowledgeTags,
      modelRoleSettings,
      modelSecrets,
      readModelEvaluation,
      judgmentUndo,
      clientLinks,
      authority,
      lanAuthorities: allowedLanAuthorities,
      lanAccessToken: lanToken
    }).catch((error) => {
      if (response.headersSent || response.destroyed) {
        // A post-response lease/storage failure cannot be converted into a second response.
        if (!response.writableEnded) response.destroy();
        console.error('Request failed after its response was committed or disconnected');
        return;
      }
      const mapped = mapHttpError(error);
      if (mapped.body.code === 'knowledge_recovery_pending') void knowledgeRecovery?.check();
      sendJson(response, mapped.status, mapped.body);
    });
  });

  try {
    await listenFetchableServer(server, port, lanEnabled ? '0.0.0.0' : '127.0.0.1', { isBlockedPort });
  } catch (error) {
    await failStartup(error);
  }
  const address = server.address();
  authority = localServerAuthority(address);
  allowedLanAuthorities = lanEnabled
    ? lanServerAuthorities(lanAddresses, address.port)
    : [];
  if (!authority) {
    await new Promise((resolveClose) => server.close(resolveClose));
    await failStartup(new Error('Server did not bind to a valid local authority'));
  }
  stopJudgment = startJudgmentScheduler({ app: application,
    ...(system?.withGraphRuntimeLease ? { withLease: (owner, run) => system.withGraphRuntimeLease(owner, run) } : {}) });
  stopClientLinkUpdates = clientLinks?.startAutoUpdate({
    onError: (error) => console.warn(`Client links were not updated: ${error?.message ?? error}`)
  }) ?? (() => {});
  // Resumes only what the owner already turned on; console LAN access never enables it.
  if (application.peer && options.peer !== false) {
    peer = createPeerRuntime({ host: application.roundtableHost, roundtable: application.roundtable, port: application.peer,
      onError: (error) => console.error(`LAN roundtable: ${error.code ?? error.message}`) });
    peer.resume().catch((error) => console.error(`LAN roundtable could not resume: ${error.code ?? error.message}`));
  }

  let closing = null;
  const close = () => {
    closing ??= new Promise((resolve, reject) => {
      closeTaskEventStreams(server);
      server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING'
        ? reject(error) : resolve());
    }).then(closeResources);
    return closing;
  };
  server.once('close', () => {
    // Legacy callers may close the raw HTTP server; still consume/report asynchronous failures.
    void closeResources().catch((error) => {
      if (!closing) console.error(`Server shutdown failed: ${error.message}`);
    });
  });
  return {
    server,
    close,
    url: `http://${authority}`,
    lanUrls: lanEnabled ? lanConsoleUrls(lanAddresses, address.port) : [],
    app: application,
    ...(workerRuntime ? { workerPlanHost: workerRuntime.host } : {})
  };
}

function resolveServerGraphOptions(options) {
  const args = [];
  if (Object.hasOwn(options, 'runtimeConfigPath')) {
    args.push('--runtime-config', options.runtimeConfigPath);
  }
  return resolveGraphRuntimeOptions(args, options.env ?? process.env, {
    setupPaths: { homeDir: options.homeDir, cwd: options.cwd ?? process.cwd() }
  });
}

export { isFetchBlockedPort } from './server/blocked-ports.js';

async function handleRequest({
  request,
  response,
  app,
  system,
  externalKnowledge,
  connectedKnowledge,
  peer,
  dataFormats,
  dataFormatMigrations,
  knowledgeHardDelete,
  knowledgeScope,
  projectHierarchy,
  taskBlockers,
  knowledgeOwnerReads,
  knowledgeTags,
  modelRoleSettings,
  modelSecrets,
  readModelEvaluation,
  judgmentUndo,
  clientLinks,
  authority,
  lanAuthorities,
  lanAccessToken
}) {
  if (rejectRequestOutsidePolicy({
    request,
    response,
    authority,
    lanAuthorities,
    lanAccessToken
  })) return;
  // A page opened from another site's link reaches the static console only.
  if (isCrossSiteNavigation(request)) {
    serveStatic(new URL(request.url, 'http://127.0.0.1').pathname, response);
    return;
  }
  if (await handleApiRequest({
    request,
    response,
    app,
    system,
    externalKnowledge,
    connectedKnowledge,
    peer,
    dataFormats,
    dataFormatMigrations,
    knowledgeHardDelete,
    knowledgeScope,
    projectHierarchy,
    taskBlockers,
    knowledgeOwnerReads,
    knowledgeTags,
    modelRoleSettings,
    modelSecrets,
    readModelEvaluation,
    judgmentUndo,
    clientLinks
  })) return;
  serveStatic(new URL(request.url, 'http://127.0.0.1').pathname, response);
}

if (isMainModule(import.meta.url)) {
  runProgram(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function runProgram(args) {
  const runtimeOptions = resolveGraphRuntimeOptions(args, process.env);
  const port = numberOption(args, '--port', DEFAULT_FULI_PORT);
  const lan = args.includes('--lan');
  const { server, close: closeRuntime, url, lanUrls } = await createServer({
    ...runtimeOptions,
    port,
    lan,
    lanAccessToken: lan ? process.env.FULI_LAN_ACCESS_TOKEN : null
  });
  const handlers = new Map();
  const close = () => {
    void closeRuntime().catch((error) => {
      console.error(`Server shutdown failed: ${error.message}`);
      process.exitCode = 1;
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = close;
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  server.once('close', () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  });
  console.log(`复利工作台 running at ${url}`);
  for (const lanUrl of lanUrls) console.log(`复利工作台 LAN at ${lanUrl}`);
}

function requiredLanToken(value) {
  if (typeof value !== 'string' || value.length < 16) {
    throw new TypeError('LAN mode requires a generated access token');
  }
  return value;
}

function numberOption(args, flag, fallback) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--') || !Number.isFinite(Number(value))) {
    throw new TypeError(`Missing or invalid value for ${flag}`);
  }
  return Number(value);
}
