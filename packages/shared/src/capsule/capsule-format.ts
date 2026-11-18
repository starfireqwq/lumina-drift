/**
 * AtelierSync Canvas Time Capsule (.ateliersync-capsule) Format & Crypto Engine
 *
 * Encapsulates:
 * 1. Full Multi-Layer High-Resolution Raster Snapshots
 * 2. Monotonic Replay Operation History Log (Ops for time-lapse & stroke reconstruction)
 * 3. Canvas & Layer Metadata (ACL, blend modes, opacities, dimensions)
 * 4. AES-256-GCM Military-grade Encryption + PBKDF2 Password Authentication
 * 5. SHA-256 Integrity Verification for Cold Backup & Disaster Recovery
 */

import { CanvasModel, LayerModel } from '../types/models';
import type { VectorStroke } from '../vector/vector-types';

export const CAPSULE_MAGIC = 'ATELIER_CAPSULE_V1';

export interface CapsuleManifest {
  magic: typeof CAPSULE_MAGIC;
  version: '1.0';
  createdAt: number;
  canvas: CanvasModel;
  layers: LayerModel[];
  vectorStrokes?: Record<string, VectorStroke[]>;
  totalOps: number;
  totalStrokes: number;
  hasReplayLog: boolean;
  isEncrypted: boolean;
  checksum: string;
}

export interface CapsuleContent {
  manifest: CapsuleManifest;
  // Multi-layer raster snapshots: layerId -> PNG base64 DataURL
  layerSnapshots: Record<string, string>;
  // Complete history stroke operations for exact time-lapse replay & reconstruction
  historyOps: any[];
  // Composite flattened canvas preview thumbnail
  thumbnailUrl?: string;
}

export interface EncryptedCapsuleEnvelope {
  magic: typeof CAPSULE_MAGIC;
  version: '1.0';
  isEncrypted: true;
  salt: string; // Base64 PBKDF2 salt
  iv: string; // Base64 AES-GCM IV (12 bytes)
  ciphertext: string; // Base64 AES-GCM encrypted payload
  checksum: string; // SHA-256 of plaintext JSON
  createdAt: number;
  canvasTitle: string;
  totalStrokes: number;
}

export type AtelierSyncCapsuleData = CapsuleContent | EncryptedCapsuleEnvelope;

/**
 * Derives an AES-GCM 256-bit CryptoKey from a user passphrase using PBKDF2
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Computes SHA-256 hex checksum of a string payload
 */
export async function computeSha256(text: string): Promise<string> {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc.encode(text));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encrypts capsule content into an encrypted envelope (.ateliersync-capsule)
 */
export async function encryptTimeCapsule(
  content: CapsuleContent,
  passphrase?: string
): Promise<EncryptedCapsuleEnvelope | CapsuleContent> {
  if (!passphrase) {
    return content;
  }

  const jsonString = JSON.stringify(content);
  const checksum = await computeSha256(jsonString);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyFromPassphrase(passphrase, salt);

  const enc = new TextEncoder();
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    enc.encode(jsonString)
  );

  const b64Salt = btoa(String.fromCharCode(...salt));
  const b64Iv = btoa(String.fromCharCode(...iv));
  const b64Ciphertext = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));

  return {
    magic: CAPSULE_MAGIC,
    version: '1.0',
    isEncrypted: true,
    salt: b64Salt,
    iv: b64Iv,
    ciphertext: b64Ciphertext,
    checksum,
    createdAt: content.manifest.createdAt,
    canvasTitle: content.manifest.canvas.title,
    totalStrokes: content.manifest.totalStrokes,
  };
}

/**
 * Decrypts an encrypted capsule envelope using passphrase, verifying SHA-256 checksum
 */
export async function decryptTimeCapsule(
  capsuleData: AtelierSyncCapsuleData,
  passphrase?: string
): Promise<CapsuleContent> {
  if (!('isEncrypted' in capsuleData) || !capsuleData.isEncrypted) {
    return capsuleData as CapsuleContent;
  }

  const envelope = capsuleData as EncryptedCapsuleEnvelope;
  if (!passphrase) {
    throw new Error('此畫布時光膠囊已加密，請輸入密碼以解密復原');
  }

  const salt = Uint8Array.from(atob(envelope.salt), (c) => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));

  const key = await deriveKeyFromPassphrase(passphrase, salt);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
  } catch (err) {
    throw new Error('解密失敗：密碼錯誤或膠囊檔案已損壞');
  }

  const dec = new TextDecoder();
  const plaintext = dec.decode(decryptedBuffer);

  // Verify Checksum
  const computedHash = await computeSha256(plaintext);
  if (computedHash !== envelope.checksum) {
    throw new Error('膠囊完整性校驗失敗：SHA-256 驗證不符，檔案可能已被篡改');
  }

  const content: CapsuleContent = JSON.parse(plaintext);
  return content;
}
