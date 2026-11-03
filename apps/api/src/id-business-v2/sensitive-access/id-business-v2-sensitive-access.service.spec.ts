import { BadRequestException, ForbiddenException, GoneException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG } from './id-business-v2-sensitive-access.catalog';
import { IdBusinessV2SensitiveAccessController } from './id-business-v2-sensitive-access.controller';
import { IdBusinessV2SensitiveAccessService } from './id-business-v2-sensitive-access.service';

const reader: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'reader',
  displayName: '合成员工',
  roles: ['employee'],
  permissions: ['apple.account.view', 'customer.view', 'apple.balance.view'],
  sensitiveApprovalPermissionCodes: ['apple.secret.view_password']
};
function fixture() {
  const repository = {
    listSensitiveDisplayPolicies: vi.fn(),
    listSensitivePermissionGrants: vi.fn(),
    verifyApproval: vi.fn(),
    listPendingSummary: vi.fn()
  };
  const service = new IdBusinessV2SensitiveAccessService(
    repository as never,
    {} as never,
    {} as never
  );
  return { service, repository };
}
describe('业务资料直接完整显示', () => {
  it('所有业务字段及使用位置完整显示，历史角色策略不再参与读取', async () => {
    const { service, repository } = fixture();
    for (const descriptor of ID_BUSINESS_V2_SENSITIVE_ACCESS_CATALOG) {
      for (const context of descriptor.contexts) {
        await expect(service.resolveDisplayMode(reader, descriptor.key, context)).resolves.toBe(
          context === 'audit' ? 'masked' : 'full'
        );
      }
    }
    expect(repository.listSensitiveDisplayPolicies).not.toHaveBeenCalled();
    expect(repository.listSensitivePermissionGrants).not.toHaveBeenCalled();
  });
  it('没有登录身份和错误字段场景仍被拒绝', async () => {
    const { service } = fixture();
    await expect(
      service.resolveDisplayMode(undefined, 'account.password', 'account_management')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.resolveDisplayMode(reader, 'account.password', 'audit')
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('有模块查看权限就能直接取值，不需要原因或审批，也不读取历史审批', async () => {
    const { service, repository } = fixture();
    await expect(
      service.authorize({} as never, {
        module: 'id_business_v2_account',
        fieldName: 'password',
        objectType: 'id_business_v2_account',
        objectId: 'account-id',
        approvalId: 'expired-legacy-approval',
        operator: reader
      })
    ).resolves.toMatchObject({ mode: 'direct', approvalId: null });
    expect(repository.verifyApproval).not.toHaveBeenCalled();
  });
  it('仅有旧敏感字段授权不能绕过业务模块权限', async () => {
    const { service } = fixture();
    await expect(
      service.authorize({} as never, {
        module: 'id_business_v2_account',
        fieldName: 'password',
        objectType: 'id_business_v2_account',
        objectId: 'account-id',
        operator: { ...reader, permissions: ['apple.secret.view_password'] }
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('原审批目录兼容返回直接查看，后台不再生成待审批提醒', async () => {
    const { service, repository } = fixture();
    const result = await service.listPolicies(reader);
    expect(result.items.every((item) => item.mode === 'direct')).toBe(true);
    await expect(
      service.listPendingSummary({ ...reader, roles: ['admin'] })
    ).resolves.toMatchObject({ pendingCount: 0, items: [] });
    expect(repository.listPendingSummary).not.toHaveBeenCalled();
  });
  it('旧申请和审批写接口返回已移除，不创建或修改历史记录', () => {
    const controller = new IdBusinessV2SensitiveAccessController({} as never);
    expect(() => controller.createRequest()).toThrow(GoneException);
    expect(() => controller.decide()).toThrow(GoneException);
  });
});
