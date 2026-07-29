import { ConfigService } from '@nestjs/config';
import { FieldEncryptionService } from './field-encryption.service';

describe('FieldEncryptionService', () => {
  it('encrypts and decrypts without exposing plaintext', () => {
    const service = new FieldEncryptionService({
      get: () => 'unit-test-secret'
    } as unknown as ConfigService);

    const encrypted = service.encrypt('secret-password');

    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toContain('secret-password');
    expect(service.decrypt(encrypted)).toBe('secret-password');
  });

  it('creates stable hashes for duplicate detection', () => {
    const service = new FieldEncryptionService({
      get: (key: string) => (key === 'HASH_SECRET' ? 'hash-secret' : 'field-secret')
    } as unknown as ConfigService);

    expect(service.hash('ABC-123')).toBe(service.hash('ABC-123'));
    expect(service.hash('ABC-123')).not.toBe(service.hash('ABC-124'));
  });
});
