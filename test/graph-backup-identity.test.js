import assert from 'node:assert/strict';
import test from 'node:test';

import {
  graphBackupSelection,
  reconcileImportedGraphIdentity
} from '../src/backup/identity-reconciliation.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';

const PATHS = {
  graphRuntimeConfigPath: '/data/graph-runtime.json',
  containerGraphConfigProfilePath: '/data/runtime-configs/container.json',
  nativeGraphConfigProfilePath: '/data/runtime-configs/native.json',
  runtimeSettingsPath: '/data/runtime-settings.json',
  graphEnvPath: '/data/graph-provider.env'
};

test('graph backup selection contains only the non-secret personal space identity', () => {
  assert.deepEqual(graphBackupSelection(PATHS, {
    readConfig: () => ({
      personal: {
        spaceId: 'personal-space-1',
        accessToken: 'must-not-be-exported',
        principalId: 'principal-1'
      }
    })
  }), { personalSpaceId: 'personal-space-1' });
});

test('import rotates target credentials and preserves same-machine external workspaces', async () => {
  const writes = [];
  const current = {
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'fresh-target-token',
      principalId: 'fresh-target-principal',
      spaceId: 'fresh-target-space'
    },
    workspaces: []
  };
  const source = {
    version: 1,
    personal: {
      providerUrl: 'http://127.0.0.1:8787',
      accessToken: 'old-source-token',
      principalId: 'old-source-principal',
      spaceId: 'source-space'
    },
    workspaces: [{
      providerUrl: 'http://127.0.0.1:8789',
      accessToken: 'external-token',
      principalId: 'external-principal',
      protocol: 'fuli-workspace-v1'
    }]
  };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith('/health')) return response({ status: 'ready' });
    if (url.endsWith('/v1/bootstrap')) {
      assert.equal(options.headers['x-fuli-bootstrap-token'], 'bootstrap-token');
      return response({ principal_id: 'imported-principal', access_token: 'rotated-token' });
    }
    if (url.endsWith('/v1/spaces')) {
      assert.equal(options.headers.authorization, 'Bearer rotated-token');
      return response([{ id: 'source-space', kind: 'personal' }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const result = await reconcileImportedGraphIdentity({
    paths: PATHS,
    instances: ['personal'],
    selection: { personalSpaceId: 'source-space' },
    sourceMode: 'container',
    targetMode: 'native',
    fetchImpl,
    readConfig: (path) => path === PATHS.containerGraphConfigProfilePath ? source : current,
    writeConfig: (path, value) => writes.push({ path, value }),
    secureConfig: () => {},
    readSettings: () => ({ ...DEFAULT_RUNTIME_SETTINGS, graphRuntimeMode: 'native' }),
    readEnvironment: async () => ({
      FULI_PERSONAL_BOOTSTRAP_TOKEN: 'bootstrap-token',
      FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN: 'workflow-observation-token-1234567890'
    })
  });

  assert.deepEqual(result, { personalSpaceId: 'source-space', instances: ['personal'] });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, PATHS.graphRuntimeConfigPath);
  assert.deepEqual(writes[0].value.personal, {
    ...current.personal,
    accessToken: 'rotated-token',
    principalId: 'imported-principal',
    spaceId: 'source-space',
    workflowObservationToken: 'workflow-observation-token-1234567890'
  });
  assert.deepEqual(writes[0].value.workspaces, source.workspaces);
});

function response(body, ok = true) {
  return { ok, async json() { return structuredClone(body); } };
}
