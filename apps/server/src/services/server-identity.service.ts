import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { config } from '../config';

/**
 * A server's long-lived identity key (ECDSA P-256), kept next to `session-secret` in DATA_DIR.
 * Clients that reach the same server through another address (LAN IP, tunnel, localhost) ask it to
 * sign a random challenge; only a matching key lets them reuse a login made at the other address.
 */
let identity: { privateKey: KeyObject; publicKey: string } | null = null;

function loadIdentity() {
  if (identity) return identity;
  const keyPath = path.join(config.dataDir, 'server-identity.pem');
  if (!fs.existsSync(keyPath)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    try {
      fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const privateKey = createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  identity = { privateKey, publicKey };
  return identity;
}

/** base64url, 16–96 random bytes. */
export const IDENTITY_CHALLENGE = /^[A-Za-z0-9_-]{22,128}$/;
export const identityMessage = (challenge: string) => `lumina-drift-identity:v1:${challenge}`;

/** Signs the challenge; the signature is raw r‖s (IEEE P1363), the format WebCrypto verifies. */
export function signIdentityChallenge(challenge: string): { key: string; signature: string } {
  const { privateKey, publicKey } = loadIdentity();
  const signature = sign('sha256', Buffer.from(identityMessage(challenge)), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { key: publicKey, signature: signature.toString('base64') };
}
