import { describe, expect, it } from 'vitest';
import { pbkdf2Sync, scryptSync } from 'node:crypto';
import { hashPassword, passwordNeedsRehash, verifyPassword } from './password-hasher';

describe('password-hasher', () => {
  it('creates a Web-Crypto-compatible PBKDF2 hash and verifies it', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');

    expect(passwordHash).toMatch(/^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(passwordNeedsRehash(passwordHash)).toBe(false);
    await expect(verifyPassword('correct horse battery staple', passwordHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', passwordHash)).resolves.toBe(false);
  });

  it('rejects malformed or under-strength PBKDF2 hashes', async () => {
    await expect(verifyPassword('password', 'pbkdf2-sha256$99999$00$00')).resolves.toBe(false);
    await expect(verifyPassword('password', 'not-a-password-hash')).resolves.toBe(false);
    await expect(verifyPassword('password', 'pbkdf2-sha256$100000$zz$zz')).resolves.toBe(false);
    await expect(verifyPassword('password', 'scrypt$zz$zz')).resolves.toBe(false);
  });

  it('verifies and upgrades legacy hashes without downgrading stronger hashes', async () => {
    const salt = '0123456789abcdef0123456789abcdef';
    const key = pbkdf2Sync('legacy password', Buffer.from(salt, 'hex'), 100_000, 64, 'sha256');
    const old = `pbkdf2-sha256$100000$${salt}$${key.toString('hex')}`;
    const scryptHash = `scrypt$${salt}$${scryptSync('legacy password', salt, 64).toString('hex')}`;
    for (const hash of [old, scryptHash]) {
      await expect(verifyPassword('legacy password', hash)).resolves.toBe(true);
      await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
      expect(passwordNeedsRehash(hash)).toBe(true);
    }
    expect(passwordNeedsRehash('pbkdf2-sha256$700000$unused$unused')).toBe(false);
  });
});
