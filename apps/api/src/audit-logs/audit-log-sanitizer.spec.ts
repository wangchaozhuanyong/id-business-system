import { describe, expect, it, vi } from 'vitest';
import { sanitizeAuditJsonValue } from './audit-log-sanitizer';
import { V2TransactionalAuditService } from '../id-business-v2/runtime/public-api';

describe('shared audit protection', () => {
  it('protects nested credential aliases while retaining ordinary values and dates', () => {
    expect(
      sanitizeAuditJsonValue({
        name: '客户',
        amount: '123456789.0001',
        updatedAt: new Date('2026-10-02T01:00:00Z'),
        hasPassword: true,
        nested: [
          {
            TOTP_SECRET: 'synthetic',
            totpSecretEncrypted: 'synthetic',
            api_key: 'synthetic',
            passwordEncrypted: 'synthetic',
            recovery_code: 'synthetic',
            queryCode: 'synthetic',
            CVV: 'synthetic'
          }
        ]
      })
    ).toEqual({
      name: '客户',
      amount: '123456789.0001',
      updatedAt: '2026-10-02T01:00:00.000Z',
      hasPassword: true,
      nested: [
        {
          TOTP_SECRET: '[REDACTED]',
          totpSecretEncrypted: '[REDACTED]',
          api_key: '[REDACTED]',
          passwordEncrypted: '[REDACTED]',
          recovery_code: '[REDACTED]',
          queryCode: '[REDACTED]',
          CVV: '[REDACTED]'
        }
      ]
    });
  });
  it('uses the same protection when the log is saved in a business transaction', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'log' });
    await new V2TransactionalAuditService().append({ auditLog: { create } } as never, {
      action: 'test.update',
      module: 'test',
      beforeData: { name: '原值', phone: 'synthetic' },
      afterData: { name: '新值', 'access-token': 'synthetic', mfaSecret: 'synthetic' }
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      beforeData: { name: '原值', phone: '[REDACTED]' },
      afterData: { name: '新值', 'access-token': '[REDACTED]', mfaSecret: '[REDACTED]' }
    });
  });
});
