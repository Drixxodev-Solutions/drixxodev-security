/**
 * tests/crypto.test.ts — Priority 1: Token Vault
 *
 * Tests AES-256-GCM encrypt/decrypt round-trips, ciphertext opacity,
 * tamper detection, and key validation.
 * Uses only throwaway fake keys — no real secrets (§7.4).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Throwaway 64-hex-char (32-byte) test key — never a real key
const FAKE_KEY_HEX = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
const FAKE_KEY_32 = "12345678901234567890123456789012"; // 32-char UTF-8

describe("Token Vault — crypto (Priority 1)", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = FAKE_KEY_HEX;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.TOKEN_ENCRYPTION_KEY = originalKey;
    }
  });

  it("round-trips a plaintext token: decrypt(encrypt(x)) === x", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const plaintext = "ya29.SomeOAuthAccessToken_ExampleOnly";
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("ciphertext is different from plaintext (not stored in clear)", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const plaintext = "super-secret-token";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).not.toContain(plaintext);
  });

  it("produces different ciphertext each call (random IV)", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const plaintext = "same-token";
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
  });

  it("round-trips with 32-char UTF-8 key", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = FAKE_KEY_32;
    // Re-import to pick up new key (module is re-evaluated per each dynamic import)
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const plaintext = "utf8-key-test-token";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("tampered ciphertext (flipped byte) throws on decrypt (GCM auth tag)", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const plaintext = "tamper-me";
    const ciphertext = encrypt(plaintext);
    const buf = Buffer.from(ciphertext, "base64");
    // Flip the last byte (in the encrypted payload region)
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("truncated ciphertext (too short) throws on decrypt", async () => {
    const { decrypt } = await import("@/lib/crypto");
    // 12 (IV) + 16 (auth tag) = 28 bytes minimum; provide fewer
    const tooShort = Buffer.alloc(20).toString("base64");
    expect(() => decrypt(tooShort)).toThrow(/too short|invalid/i);
  });

  it("throws a clear error when TOKEN_ENCRYPTION_KEY is missing", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const { encrypt } = await import("@/lib/crypto");
    expect(() => encrypt("anything")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it("throws a clear error when TOKEN_ENCRYPTION_KEY is wrong length", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = "tooshort";
    const { encrypt } = await import("@/lib/crypto");
    expect(() => encrypt("anything")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  // Regression: an empty-string ciphertext is exactly IV+tag (28 bytes). The
  // decrypt() length guard must accept it (it previously used `< 28 + 1` and
  // wrongly rejected valid empty-plaintext ciphertext — fixed in lib/crypto.ts).
  it("round-trips an empty string", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("round-trips a long Unicode string (e.g. refresh token with special chars)", async () => {
    const { encrypt, decrypt } = await import("@/lib/crypto");
    const token = "1//Abc-DEF_ghi" + "x".repeat(512) + "😀🔑";
    expect(decrypt(encrypt(token))).toBe(token);
  });
});
