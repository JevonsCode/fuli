import { boundedString, enumSchema, integerSchema, objectSchema } from './schema.js';

// An Agent records a server it started (rec#11 D-71). One tool, register or
// update, like register_standing_assignment; full profile only, chat reaches
// it through list_agent_interfaces/fuli_call. Stopping a service, deleting a
// record and reading or clearing logs belong to the person in the console.
export const AGENT_SERVICE_DEFINITIONS = [
  {
    name: 'report_agent_service',
    title: 'WRITE · Record a service you started',
    description: 'After you start a long-running server (dev server, Node/Python server, anything that listens), register it: address, purpose, pid, command. When you stop or restart it, update it (serviceId; state stopped|running, new pid). Owner comes from the task. Only the person stops services through FULI.',
    inputSchema: objectSchema({
      action: enumSchema(['register', 'update']),
      taskContextToken: boundedString(256),
      serviceId: boundedString(200),
      address: { ...boundedString(300), description: 'URL or host:port' },
      purpose: boundedString(500),
      pid: integerSchema({ minimum: 1 }),
      command: boundedString(1000),
      state: enumSchema(['running', 'stopped'])
    }, ['action', 'taskContextToken'])
  }
];
