import 'reflect-metadata';
import { BasicConstraintsExtension, X509CertificateGenerator } from '@peculiar/x509';
import { createPrivateKey, randomBytes, sign, verify, webcrypto, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, pemToDer, sha256Hex } from './protocol.js';

const KEY_FILE = 'device-key.pem';
const CERT_FILE = 'device-cert.pem';
const VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };

// One key pair per installation. The private key never leaves this directory;
// other devices only ever see the self-signed certificate and its fingerprint.
export async function loadDeviceIdentity(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, KEY_FILE);
  const certPath = join(directory, CERT_FILE);
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const created = await createDeviceCertificate();
    writeFileSync(keyPath, created.keyPem, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    writeFileSync(certPath, created.certPem, { mode: 0o644 });
  }
  return deviceIdentity({ keyPem: readFileSync(keyPath, 'utf8'), certPem: readFileSync(certPath, 'utf8') });
}

export function deviceIdentity({ keyPem, certPem }) {
  const key = createPrivateKey(keyPem);
  return Object.freeze({
    fingerprint: certificateFingerprint(certPem),
    certPem,
    tlsOptions: Object.freeze({ key: keyPem, cert: certPem }),
    sign: (value) => sign('sha256', Buffer.from(canonicalJson(value)), key).toString('base64'),
  });
}

export function certificateFingerprint(certPem) {
  return sha256Hex(pemToDer(certPem));
}

export function verifyDeviceSignature(certPem, value, signature) {
  if (typeof signature !== 'string' || signature.length > 512) return false;
  try {
    const certificate = new X509Certificate(certPem);
    return verify('sha256', Buffer.from(canonicalJson(value)), certificate.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export async function createDeviceCertificate({ now = Date.now() } = {}) {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    // A unique subject keeps several paired self-signed certificates unambiguous in one trust store.
    name: `CN=FULI device ${randomBytes(8).toString('hex')}`,
    serialNumber: `01${randomBytes(15).toString('hex')}`,
    notBefore: new Date(now - 24 * 60 * 60 * 1000),
    notAfter: new Date(now + VALIDITY_MS),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [new BasicConstraintsExtension(true, undefined, true)],
  }, webcrypto);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  return {
    certPem: `${certificate.toString('pem').trim()}\n`,
    keyPem: `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
  };
}
