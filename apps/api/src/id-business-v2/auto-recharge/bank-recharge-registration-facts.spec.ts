import { describe, expect, it, vi } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { listChatgptAccounts } from './bank-recharge-account-list';

describe('统一台账的注册资料', () => {
  it('真实注册资料独立于登录网络及入库时间，未知资料不推算', async () => {
    const encryption = new FieldEncryptionService({ get: () => 'synthetic-test' } as never);
    const registeredAt = new Date('2026-01-01T01:02:03Z');
    const createdAt = new Date('2026-10-16T00:00:00Z');
    const repository = {
      renewalWarningDays: async () => 3,
      listAccounts: async () => [
        {
          id: 'automatic',
          emailHash: 'h1',
          emailMasked: 'a***@example.test',
          status: 'active',
          passwordEncrypted: 'saved',
          registrationCountryCode: 'PH',
          registeredAt,
          createdAt,
          registrationIpEncrypted: encryption.encrypt('203.0.113.8')
        },
        {
          id: 'manual',
          emailHash: 'h2',
          emailMasked: 'b***@example.test',
          status: 'active',
          createdAt
        }
      ],
      subscriptionsForAccounts: async () => [],
      loginNetworksByEmailHashes: async () => [],
      openingCardsForAccounts: async () => [],
      registrationSourceAudits: vi.fn(async () => [
        {
          objectId: 'automatic',
          action: 'id_business_v2.auto_registration.chatgpt_account.mirror',
          afterData: { identityStatus: 'creation_confirmed' }
        },
        {
          // 回执可以迟到；同任务已有 verified 不能被旧 partial 降级。
          objectId: 'automatic',
          action: 'id_business_v2.auto_registration.chatgpt_account.mirror',
          afterData: { identityStatus: 'verified' }
        },
        {
          objectId: 'manual',
          action: 'id_business_v2.auto_registration.chatgpt_account.manual_registered_mirror'
        }
      ])
    };
    const result = await listChatgptAccounts({}, repository as never, encryption);
    expect(result.items[0]).toMatchObject({
      registrationIp: '203.0.113.8',
      registeredAt,
      registrationSource: 'automatic',
      needsSupplement: false
    });
    expect(result.items[1]).toMatchObject({
      registrationIp: null,
      registeredAt: null,
      registrationSource: 'manual',
      needsSupplement: true
    });
    expect(repository.registrationSourceAudits).toHaveBeenCalledWith(['automatic', 'manual']);
    expect(result.items[1]?.registeredAt).not.toBe(createdAt);
  });
});
