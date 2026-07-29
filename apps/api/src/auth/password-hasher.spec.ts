import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password-hasher';

describe('password-hasher', () => {
  it('creates a Cloudflare-compatible PBKDF2 hash and verifies it', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');

    expect(passwordHash).toMatch(/^pbkdf2-sha256\$100000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    await expect(verifyPassword('correct horse battery staple', passwordHash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', passwordHash)).resolves.toBe(false);
  });

  it('rejects malformed or under-strength PBKDF2 hashes', async () => {
    await expect(verifyPassword('password', 'pbkdf2-sha256$99999$00$00')).resolves.toBe(false);
    await expect(verifyPassword('password', 'not-a-password-hash')).resolves.toBe(false);
  });
});
