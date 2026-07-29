import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from './prisma/prisma.service';
import { verifySensitiveAccessApproval } from './sensitive-access-approval';

describe('verifySensitiveAccessApproval', () => {
  const baseApproval = {
    id: '11111111-1111-4111-8111-111111111111',
    requesterId: 'operator-id',
    approverId: 'approver-id',
    module: 'apple_account',
    fieldName: 'password',
    objectType: 'apple_account',
    objectId: '22222222-2222-4222-8222-222222222222',
    reason: '售后登录核对',
    status: 'approved',
    decisionNote: null,
    approvedAt: new Date('2026-06-20T00:00:00.000Z'),
    expiresAt: new Date('2026-06-21T00:00:00.000Z'),
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: new Date('2026-06-20T00:00:00.000Z')
  };

  it('returns false when no approval id is provided', async () => {
    const prisma = {
      sensitiveAccessApproval: {
        findUnique: jest.fn()
      }
    } as unknown as PrismaService;

    await expect(
      verifySensitiveAccessApproval(prisma, {
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        objectId: '22222222-2222-4222-8222-222222222222',
        requesterId: 'operator-id'
      })
    ).resolves.toBe(false);
    expect(prisma.sensitiveAccessApproval.findUnique).not.toHaveBeenCalled();
  });

  it('approves only a matching approved and unexpired approval', async () => {
    const prisma = {
      sensitiveAccessApproval: {
        findUnique: jest.fn().mockResolvedValue(baseApproval)
      }
    } as unknown as PrismaService;

    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: baseApproval.id,
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        objectId: '22222222-2222-4222-8222-222222222222',
        requesterId: 'operator-id',
        now: new Date('2026-06-20T12:00:00.000Z')
      })
    ).resolves.toBe(true);
  });

  it('rejects invalid, missing, mismatched, unapproved, and expired approvals', async () => {
    const prisma = {
      sensitiveAccessApproval: {
        findUnique: jest.fn()
      }
    } as unknown as PrismaService;

    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: 'not-a-uuid',
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        requesterId: 'operator-id'
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    (prisma.sensitiveAccessApproval.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: baseApproval.id,
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        requesterId: 'operator-id'
      })
    ).rejects.toBeInstanceOf(NotFoundException);

    (prisma.sensitiveAccessApproval.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseApproval,
      requesterId: 'other-user'
    });
    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: baseApproval.id,
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        objectId: baseApproval.objectId,
        requesterId: 'operator-id'
      })
    ).rejects.toBeInstanceOf(ForbiddenException);

    (prisma.sensitiveAccessApproval.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseApproval,
      status: 'pending'
    });
    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: baseApproval.id,
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        objectId: baseApproval.objectId,
        requesterId: 'operator-id'
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    (prisma.sensitiveAccessApproval.findUnique as jest.Mock).mockResolvedValueOnce({
      ...baseApproval,
      fieldName: 'phone'
    });
    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: baseApproval.id,
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        objectId: baseApproval.objectId,
        requesterId: 'operator-id'
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    (prisma.sensitiveAccessApproval.findUnique as jest.Mock).mockResolvedValueOnce(baseApproval);
    await expect(
      verifySensitiveAccessApproval(prisma, {
        approvalId: baseApproval.id,
        module: 'apple_account',
        fieldName: 'password',
        objectType: 'apple_account',
        objectId: baseApproval.objectId,
        requesterId: 'operator-id',
        now: new Date('2026-06-21T00:00:00.000Z')
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
