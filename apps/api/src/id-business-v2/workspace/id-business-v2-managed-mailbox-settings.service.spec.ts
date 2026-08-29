import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ManagedMailboxSettingsService } from './id-business-v2-managed-mailbox-settings.service';

const admin = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const member = { ...admin, roles: ['member'] };
const now = new Date('2026-08-29T12:00:00.000Z');

describe('IdBusinessV2ManagedMailboxSettingsService', () => {
  const tx = {};
  const repository = {
    getQueryCodeSettings: vi.fn(),
    upsertQueryCodeSettings: vi.fn(),
    updateAllQueryCodeExpirations: vi.fn()
  };
  const transactionManager = {
    execute: vi.fn(async (work: (client: unknown, context: { businessTime: Date }) => unknown) =>
      work(tx, { businessTime: now })
    )
  };
  const audit = { append: vi.fn() };
  const service = new IdBusinessV2ManagedMailboxSettingsService(
    repository as never,
    transactionManager as never,
    audit as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    repository.getQueryCodeSettings.mockResolvedValue(null);
    repository.upsertQueryCodeSettings.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      scope: 'global',
      queryCodeValidityDays: 45,
      updatedByUserId: admin.id,
      createdAt: now,
      updatedAt: now
    });
    repository.updateAllQueryCodeExpirations.mockResolvedValue({ count: 3 });
    audit.append.mockResolvedValue({ id: 'audit-1' });
  });

  it('returns the safe 30-day default when no setting exists', async () => {
    await expect(service.getSettings(admin)).resolves.toMatchObject({
      validityDays: 30,
      rotationMode: 'manual',
      updatedAt: null
    });
  });

  it('updates the global validity and optionally synchronizes existing codes', async () => {
    const result = await service.updateSettings({ validityDays: 45, applyToExisting: true }, admin);
    expect(repository.updateAllQueryCodeExpirations).toHaveBeenCalledWith(
      tx,
      new Date('2026-10-13T12:00:00.000Z'),
      admin.id
    );
    expect(result).toMatchObject({ validityDays: 45, updatedExistingCount: 3 });
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'id_business_v2.managed_mailbox.query_code_settings_update'
      })
    );
  });

  it('does not change existing expirations unless explicitly requested', async () => {
    await service.updateSettings({ validityDays: 45, applyToExisting: false }, admin);
    expect(repository.updateAllQueryCodeExpirations).not.toHaveBeenCalled();
  });

  it('rejects invalid validity days and non-admin operators', async () => {
    await expect(
      service.updateSettings({ validityDays: 0, applyToExisting: false }, admin)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getSettings(member)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
