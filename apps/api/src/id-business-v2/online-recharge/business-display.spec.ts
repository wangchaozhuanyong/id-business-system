import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { OnlineRechargeAdminRepository } from './persistence/admin.repository';
import { OnlineRechargeTasksRepository } from './persistence/tasks.repository';
import { assertOnlineSensitive } from './assets.service';
const reader: AuthenticatedUser = {
  id: 'fixture-reader',
  username: 'reader',
  displayName: '合成员工',
  roles: ['employee'],
  permissions: ['id_business_v2.online_recharge.read'],
  sensitiveApprovalPermissionCodes: ['id_business_v2.online_recharge.sensitive']
};
const taskId = '11111111-1111-4111-8111-111111111111';
const decrypt = (value: unknown) =>
  ({
    'fixture-card': '4111111111111111',
    'fixture-code': 'KC-TEST-ONLY',
    'fixture-email': 'fixture@example.invalid',
    'fixture-session': '{"fixture":true}'
  })[String(value)] ?? null;
function fixture(section: string) {
  const rows =
    section === 'cards'
      ? [
          {
            id: 'fixture-card-id',
            numberEncrypted: 'fixture-card',
            last4: '1111',
            status: 'active'
          }
        ]
      : [
          {
            id: 'fixture-code-id',
            codeEncrypted: 'fixture-code',
            codeLast4: 'ONLY',
            status: 'available'
          }
        ];
  const db = {
    onlineRechargeAddress: { findMany: vi.fn(async () => []) },
    onlineRechargeTask: {
      findUnique: vi.fn(async () => ({ id: taskId, sessionEncrypted: 'fixture-session' }))
    }
  };
  const repository = {
    list: vi.fn(async () => ({ items: rows, total: 1 })),
    read: async (work: (client: typeof db) => unknown) => work(db),
    transaction: async (_key: string, work: (client: typeof db) => unknown) => work(db),
    log: vi.fn()
  };
  const encryption = { decrypt };
  return {
    repository,
    encryption,
    admin: new OnlineRechargeAdminRepository(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      { available: async () => [] } as never,
      {} as never,
      encryption as never
    )
  };
}
describe('线上代充完整资料读取', () => {
  it('模块读取授权直接查看，旧审批标记不再拦截，无权限者仍拒绝', () => {
    expect(() => assertOnlineSensitive(reader)).not.toThrow();
    expect(() => assertOnlineSensitive({ ...reader, permissions: [] })).toThrow(ForbiddenException);
  });
  it.each(['cards', 'cdks'])('后台 %s 列表返回完整业务值，不返回密文和盲索引', async (section) => {
    const { admin } = fixture(section);
    const result = await admin.list(section, {}, reader);
    expect(result.items[0]).toMatchObject(
      section === 'cards' ? { number: '4111111111111111' } : { code: 'KC-TEST-ONLY' }
    );
    expect(result.items[0]).not.toHaveProperty(
      section === 'cards' ? 'numberEncrypted' : 'codeEncrypted'
    );
  });
  it('查看 Session 不需要 reason 或 approvalId，并继续记录访问审计', async () => {
    const { repository, encryption } = fixture('sessions');
    const tasks = new OnlineRechargeTasksRepository(
      repository as never,
      {} as never,
      encryption as never,
      {} as never,
      {} as never
    );
    await expect(tasks.action('sessions', 'reveal', { id: taskId }, reader)).resolves.toMatchObject(
      { session: '{"fixture":true}' }
    );
    expect(repository.log).toHaveBeenCalledWith(
      expect.anything(),
      'sessions.reveal',
      reader,
      taskId
    );
  });
  it('完整邮箱仅返回给后台，公开任务不包含邮箱、银行卡或 Session', () => {
    const { repository, encryption } = fixture('sessions');
    const tasks = new OnlineRechargeTasksRepository(
      repository as never,
      {} as never,
      encryption as never,
      {} as never,
      {} as never
    );
    const row = {
      id: taskId,
      emailEncrypted: 'fixture-email',
      sessionEncrypted: 'fixture-session',
      cardLast4: '1111',
      message: '',
      result: {}
    } as never;
    expect(tasks.map(row)).toMatchObject({ email: 'fixture@example.invalid' });
    const external = tasks.map(row, true);
    expect(external.email).toBeUndefined();
    expect(external.cardLast4).toBeUndefined();
    expect(external).not.toHaveProperty('session');
  });
});
