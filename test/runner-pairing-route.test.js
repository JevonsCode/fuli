import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { pairedInvitationAgent } from '../src/runner/pairing-agent.js';

const interfaces = () => ({
  en0: [{ family: 'IPv4', internal: false, address: '192.168.6.4', cidr: '192.168.6.4/23' }],
  utun3: [{ family: 'IPv4', internal: false, address: '192.168.7.9', cidr: '192.168.7.9/24' }],
});

test('an invitation obtains one verified connection over a LAN adapter across subnets when the default route hangs', async () => {
  const attempts = [];
  function connect(options) {
    const socket = new EventEmitter();
    socket.destroy = () => { socket.destroyed = true; };
    attempts.push({ options, socket });
    if (options.localAddress) queueMicrotask(() => socket.emit('secureConnect'));
    return socket;
  }
  const checkServerIdentity = () => new Error('wrong test certificate');
  const tls = { minVersion: 'TLSv1.3', checkServerIdentity };
  const agent = pairedInvitationAgent(tls, { interfaces, connect });
  try {
    const selected = await new Promise((resolve, reject) => agent.createConnection(
      { host: '192.168.11.31', port: 40322 }, (error, socket) => error ? reject(error) : resolve(socket)));
    assert.deepEqual(attempts.map(a => a.options.localAddress), [undefined, '192.168.6.4']);
    assert.equal(selected, attempts[1].socket);
    assert.equal(attempts[0].socket.destroyed, true);
    assert.ok(attempts.every(attempt => attempt.options.checkServerIdentity === checkServerIdentity));
  } finally { agent.destroy(); }
});

test('when all pairing paths reject TLS or close early, HTTP never receives a socket', async () => {
  const sockets = [];
  function connect(options) {
    const socket = new EventEmitter();
    socket.destroy = () => { socket.destroyed = true; };
    sockets.push(socket);
    queueMicrotask(() => {
      if (options.localAddress) socket.emit('close');
      else socket.emit('error', new Error('certificate rejected'));
    });
    return socket;
  }
  const agent = pairedInvitationAgent({}, { interfaces, connect });
  try {
    await assert.rejects(new Promise((resolve, reject) => agent.createConnection(
      { host: '192.168.11.31', port: 40322 }, (error, socket) => error ? reject(error) : resolve(socket))), AggregateError);
    assert.ok(sockets.length === 2 && sockets.every(socket => socket.destroyed));
  } finally { agent.destroy(); }
});
