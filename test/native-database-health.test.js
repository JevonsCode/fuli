import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeGraphServices, NATIVE_NEO4J_VERSION } from '../src/native-runtime/runtime.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/system/runtime-settings.js';
function services(version) {
  return createNativeGraphServices({ platform: 'linux', personalOnly: true,
    paths: { graphEnvPath: '/synthetic/env', nativePersonalDir: '/synthetic/personal', runtimeSettingsPath: '/synthetic/settings' },
    runtimeDescriptor: { status: 'ready', mode: 'native', javaHome: '/synthetic/java', neo4jHome: '/synthetic/assets', providerPython: '/synthetic/python', neo4jVersion: NATIVE_NEO4J_VERSION },
    readText: async () => 'FULI_PERSONAL_NEO4J_PASSWORD=synthetic-password\nFULI_PERSONAL_BOOTSTRAP_TOKEN=synthetic-bootstrap',
    readSettings: () => DEFAULT_RUNTIME_SETTINGS,
    fetchImpl: async () => Response.json({ errors: [], results: [{ data: [{ row: [version] }] }] }) });
}
test('database health checks actual version without requiring any graph relationships', async () => {
  await services(NATIVE_NEO4J_VERSION).checkDatabaseHealth('personal');
  await assert.rejects(services('5.26.0').checkDatabaseHealth('personal'), /version|health/i);
});
