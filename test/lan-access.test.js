import assert from 'node:assert/strict';
import test from 'node:test';

import { rejectRequestOutsidePolicy } from '../src/http/request-policy.js';
import {
  discoverLanAddresses,
  lanConsoleUrls,
  lanServerAuthorities
} from '../src/server/lan-access.js';

test('LAN discovery keeps only private non-loopback IPv4 addresses', () => {
  const addresses = discoverLanAddresses({
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: '192.168.31.8', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false }
    ],
    vpn: [
      { address: '10.0.0.9', family: 4, internal: false },
      { address: '203.0.113.7', family: 4, internal: false }
    ]
  });

  assert.deepEqual(addresses, ['10.0.0.9', '192.168.31.8']);
  assert.deepEqual(lanConsoleUrls(addresses, 2727), [
    'http://10.0.0.9:2727',
    'http://192.168.31.8:2727'
  ]);
  assert.deepEqual(lanServerAuthorities(addresses, 80), [
    '10.0.0.9',
    '192.168.31.8'
  ]);
});

test('LAN authorities require the generated Basic Auth access code', () => {
  const authority = '127.0.0.1:2727';
  const lanAuthority = '192.168.31.8:2727';
  const token = 'temporary-access-code';

  const missing = responseRecorder();
  assert.equal(rejectRequestOutsidePolicy({
    request: request(lanAuthority),
    response: missing,
    authority,
    lanAuthorities: [lanAuthority],
    lanAccessToken: token
  }), true);
  assert.equal(missing.status, 401);
  assert.match(missing.headers['www-authenticate'], /FULI LAN/);

  const accepted = responseRecorder();
  assert.equal(rejectRequestOutsidePolicy({
    request: request(lanAuthority, token),
    response: accepted,
    authority,
    lanAuthorities: [lanAuthority],
    lanAccessToken: token
  }), false);
  assert.equal(accepted.status, null);

  const loopback = responseRecorder();
  assert.equal(rejectRequestOutsidePolicy({
    request: request(authority, null, '127.0.0.1'),
    response: loopback,
    authority,
    lanAuthorities: [lanAuthority],
    lanAccessToken: token
  }), false);

  const spoofedLoopback = responseRecorder();
  assert.equal(rejectRequestOutsidePolicy({
    request: request(authority, null, '192.168.31.20'),
    response: spoofedLoopback,
    authority,
    lanAuthorities: [lanAuthority],
    lanAccessToken: token
  }), true);
  assert.equal(spoofedLoopback.status, 403);
});

test('LAN policy rejects a valid code sent from a foreign Host or Origin', () => {
  const token = 'temporary-access-code';
  for (const headers of [
    request('attacker.example', token).headers,
    {
      ...request('192.168.31.8:2727', token).headers,
      origin: 'https://attacker.example'
    }
  ]) {
    const response = responseRecorder();
    assert.equal(rejectRequestOutsidePolicy({
      request: { method: 'GET', url: '/api/state', headers },
      response,
      authority: '127.0.0.1:2727',
      lanAuthorities: ['192.168.31.8:2727'],
      lanAccessToken: token
    }), true);
    assert.equal(response.status, 403);
  }
});

function request(host, token = null, remoteAddress = '192.168.31.20') {
  return {
    method: 'GET',
    url: '/api/state',
    socket: { remoteAddress },
    headers: {
      host,
      ...(token
        ? { authorization: `Basic ${Buffer.from(`fuli:${token}`).toString('base64')}` }
        : {})
    }
  };
}

function responseRecorder() {
  return {
    status: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) {
        this.headers[name.toLowerCase()] = value;
      }
    },
    end() {}
  };
}
