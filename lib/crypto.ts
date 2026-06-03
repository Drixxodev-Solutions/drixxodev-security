/**
 * lib/crypto.ts — Token Vault crypto helpers (§6.2)
 *
 * Provides AES-256-GCM encrypt/decrypt using the operator-held TOKEN_ENCRYPTION_KEY.
 * Tokens are ONLY decrypted in-memory at call time; never logged in plaintext (§7.2).
 *
 * Ciphertext format (base64-encoded):
 *   [ 12-byte IV | 16-byte auth tag | N-byte encrypted data ]
 *
 * // TODO: migrate to a managed KMS before real scale (§6.2)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Provide a 64-hex-character (32-byte) key."
    );
  }
  // Accept either 64-char hex string or 32-char raw string
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (raw.length === 32) {
    return Buffer.from(raw, "utf8");
  }
  throw new Error(
    "TOKEN_ENCRYPTION_KEY must be either a 64-character hex string or a 32-character UTF-8 string (both produce a 32-byte AES-256 key)."
  );
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string: IV + auth tag + ciphertext.
 * Never log the input or output — both reveal or can be used to derive the token (§7.2).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Prepend IV and auth tag so decrypt() is self-contained
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
}

/**
 * Decrypts a ciphertext string produced by encrypt().
 * Returns the original plaintext string.
 * Throws if the key is wrong or the data has been tampered with (auth tag mismatch).
 * Never log the return value (§7.2).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const combined = Buffer.from(ciphertext, "base64");

  // Minimum valid size = IV + auth tag (a zero-length plaintext encrypts to
  // exactly this). Anything shorter is truncated/invalid.
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid ciphertext: too short to be a valid encrypted token.");
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
