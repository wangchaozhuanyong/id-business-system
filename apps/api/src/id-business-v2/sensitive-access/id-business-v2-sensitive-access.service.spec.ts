import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { listIdBusinessV2SensitiveDisplayCatalog } from './id-business-v2-sensitive-access.catalog';
import { IdBusinessV2SensitiveAccessService } from './id-business-v2-sensitive-access.service';

const requester: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'operator',
  displayName: '运营人员',
  roles: ['operation'],
  permissions: ['apple.secret.view_password']
};
const admin: AuthenticatedUser = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const accountViewer: AuthenticatedUser = {
  ...requester,
  permissions: ['apple.account.view_full']
};
const accountId = '33333333-3333-4333-8333-333333333333';
const approvalId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-08-07T12:00:00.000Z');

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: approvalId,
    requesterId: requester.id,
    requester: {
      id: requester.id,
      username: requester.username,
      displayName: requester.displayName
    },
    approverId: null,
    approver: null,
    module: 'id_business_v2_account',
    fieldName: 'password',
    objectType: 'id_business_v2_account',
    objectId: accountId,
    reason: '客户续费登录核对',
    status: 'pending',
    decisionNote: null,
    approvedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function createFixture() {
  const tx = { auditLog: { create: vi.fn() } };
  const repository = {
    listSensitivePermissionGrants: vi.fn(),
    listSensitiveDisplayPolicies: vi.fn().mockResolvedValue([]),
    verifyApproval: vi.fn(),
    findApprovalReason: vi.fn(),
    findPending: vi.fn(),
    createPending: vi.fn(),
    list: vi.fn(),
    listPendingSummary: vi.fn(),
    findById: vi.fn(),
    decidePending: vi.fn(),
    resolveTargetLabel: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: typeof tx, context: { businessTime: Date }) => unknown) =>
      work(tx, { businessTime: now })
    )
  };
  const transactionalAudit = {
    append: vi.fn().mockResolvedValue({ id: 'audit-id' })
  };
  return {
    service: new IdBusinessV2SensitiveAccessService(
      repository as never,
      transactionManager as never,
      transactionalAudit as never
    ),
    repository,
    tx,
    transactionManager,
    transactionalAudit
  };
}

describe('IdBusinessV2SensitiveAccessService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves admin bypass, direct access and approval-required role policies', async () => {
    const fixture = createFixture();
    fixture.repository.listSensitivePermissionGrants.mockResolvedValue([
      {
        sensitiveApprovalRequired: false,
        permission: { code: 'apple.secret.view_password' }
      }
    ]);

    const direct = await fixture.service.listPolicies(requester);
    expect(
      direct.items.find((item) => item.permissionCode === 'apple.secret.view_password')?.mode
    ).toBe('direct');

    fixture.repository.listSensitivePermissionGrants.mockResolvedValue([
      {
        sensitiveApprovalRequired: true,
        permission: { code: 'apple.secret.view_password' }
      }
    ]);
    const approvalRequired = await fixture.service.listPolicies(requester);
    expect(
      approvalRequired.items.find((item) => item.permissionCode === 'apple.secret.view_password')
        ?.mode
    ).toBe('approval_required');

    const adminPolicies = await fixture.service.listPolicies(admin);
    expect(adminPolicies.items.every((item) => item.mode === 'admin_bypass')).toBe(true);
  });

  it('uses safe administrator defaults for inline display and audit contexts', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.resolveDisplayMode(admin, 'account.apple_id', 'account_management')
    ).resolves.toBe('full');
    await expect(
      fixture.service.resolveDisplayMode(admin, 'account.password', 'account_management')
    ).resolves.toBe('reveal_direct');
    await expect(
      fixture.service.resolveDisplayMode(admin, 'account.apple_id', 'audit')
    ).resolves.toBe('masked');
  });

  it('never allows full values in audit policy options or legacy role fallbacks', async () => {
    const fixture = createFixture();
    fixture.repository.listSensitivePermissionGrants.mockResolvedValue([
      {
        roleId: 'legacy-role',
        sensitiveApprovalRequired: false,
        permission: { code: 'apple.account.view_full' }
      }
    ]);

    expect(
      listIdBusinessV2SensitiveDisplayCatalog()
        .filter((item) => item.context === 'audit')
        .every((item) => !item.allowedModes.includes('full'))
    ).toBe(true);
    await expect(
      fixture.service.resolveDisplayMode(accountViewer, 'account.apple_id', 'audit')
    ).resolves.toBe('masked');
  });

  it('requires the base permission and merges policies from multiple roles by visibility', async () => {
    const fixture = createFixture();
    fixture.repository.listSensitivePermissionGrants.mockResolvedValue([
      {
        roleId: 'role-hidden',
        sensitiveApprovalRequired: false,
        permission: { code: 'apple.account.view_full' }
      },
      {
        roleId: 'role-legacy-direct',
        sensitiveApprovalRequired: false,
        permission: { code: 'apple.account.view_full' }
      }
    ]);
    fixture.repository.listSensitiveDisplayPolicies.mockResolvedValue([
      {
        fieldKey: 'account.apple_id',
        context: 'account_management',
        mode: 'hidden',
        role: {
          id: 'role-hidden',
          rolePermissions: [{ permission: { code: 'apple.account.view_full' } }]
        }
      }
    ]);

    await expect(
      fixture.service.resolveDisplayMode(accountViewer, 'account.apple_id', 'account_management')
    ).resolves.toBe('reveal_direct');
    await expect(
      fixture.service.resolveDisplayMode(requester, 'account.apple_id', 'account_management')
    ).resolves.toBe('masked');
  });

  it('fails closed until a matching approved and unexpired request is provided', async () => {
    const fixture = createFixture();
    fixture.repository.listSensitivePermissionGrants.mockResolvedValue([
      {
        sensitiveApprovalRequired: true,
        permission: { code: 'apple.secret.view_password' }
      }
    ]);

    await expect(
      fixture.service.authorize(fixture.tx as never, {
        module: 'id_business_v2_account',
        fieldName: 'password',
        objectType: 'id_business_v2_account',
        objectId: accountId,
        operator: requester,
        now
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    fixture.repository.verifyApproval.mockResolvedValue(undefined);
    fixture.repository.findApprovalReason.mockResolvedValue({
      id: approvalId,
      reason: '客户续费登录核对'
    });
    await expect(
      fixture.service.authorize(fixture.tx as never, {
        module: 'id_business_v2_account',
        fieldName: 'password',
        objectType: 'id_business_v2_account',
        objectId: accountId,
        approvalId,
        operator: requester,
        now
      })
    ).resolves.toMatchObject({ mode: 'approval', approvalId });
  });

  it('creates one scoped pending request and records an audit event', async () => {
    const fixture = createFixture();
    fixture.repository.listSensitivePermissionGrants.mockResolvedValue([
      {
        sensitiveApprovalRequired: true,
        permission: { code: 'apple.secret.view_password' }
      }
    ]);
    fixture.repository.resolveTargetLabel.mockResolvedValue('te****@example.com');
    fixture.repository.findPending.mockResolvedValue(null);
    fixture.repository.createPending.mockResolvedValue(approval());

    const result = await fixture.service.createRequest(
      {
        module: 'id_business_v2_account',
        fieldName: 'password',
        objectType: 'id_business_v2_account',
        objectId: accountId,
        reason: '客户续费登录核对'
      },
      requester
    );

    expect(result).toMatchObject({ status: 'pending', targetLabel: 'te****@example.com' });
    expect(fixture.repository.createPending).toHaveBeenCalledTimes(1);
    expect(fixture.transactionalAudit.append).toHaveBeenCalledWith(
      fixture.tx,
      expect.objectContaining({ action: 'id_business_v2.sensitive_access.request' })
    );
  });

  it('allows only the first administrator decision and grants a 15-minute window', async () => {
    const fixture = createFixture();
    fixture.repository.findById.mockResolvedValueOnce(approval()).mockResolvedValueOnce(
      approval({
        status: 'approved',
        approverId: admin.id,
        approver: admin,
        approvedAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000)
      })
    );
    fixture.repository.decidePending.mockResolvedValue({ count: 1 });
    fixture.repository.resolveTargetLabel.mockResolvedValue('te****@example.com');

    const result = await fixture.service.decide(approvalId, { decision: 'approved' }, admin);

    expect(result).toMatchObject({ status: 'approved', approverId: admin.id });
    expect(fixture.repository.decidePending).toHaveBeenCalledWith(
      fixture.tx,
      expect.objectContaining({ id: approvalId, status: 'approved' })
    );
    const update = fixture.repository.decidePending.mock.calls[0]?.[1];
    expect(update.expiresAt.toISOString()).toBe('2026-08-07T12:15:00.000Z');
  });
});
