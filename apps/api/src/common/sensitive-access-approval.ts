import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma/prisma.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SensitiveAccessApprovalCheckInput {
  approvalId?: string | null;
  requesterId?: string | null;
  module: string;
  fieldName: string;
  objectType: string;
  objectId?: string | null;
  now?: Date;
}

export async function verifySensitiveAccessApproval(
  prisma: PrismaService | Pick<Prisma.TransactionClient, 'sensitiveAccessApproval'>,
  input: SensitiveAccessApprovalCheckInput
) {
  const approvalId = input.approvalId?.trim();
  if (!approvalId) {
    return false;
  }

  if (!UUID_PATTERN.test(approvalId)) {
    throw new BadRequestException('approvalId is invalid');
  }

  const approval = await prisma.sensitiveAccessApproval.findUnique({
    where: { id: approvalId }
  });

  if (!approval) {
    throw new NotFoundException('Sensitive access approval not found');
  }

  if (approval.requesterId !== input.requesterId) {
    throw new ForbiddenException('Sensitive access approval requester does not match current user');
  }

  if (approval.status !== 'approved') {
    throw new BadRequestException('Sensitive access approval is not approved');
  }

  if (approval.module !== input.module) {
    throw new BadRequestException('Sensitive access approval module does not match');
  }

  if (approval.fieldName !== input.fieldName) {
    throw new BadRequestException('Sensitive access approval field does not match');
  }

  if (approval.objectType !== input.objectType) {
    throw new BadRequestException('Sensitive access approval object type does not match');
  }

  if (approval.objectId && approval.objectId !== (input.objectId ?? null)) {
    throw new BadRequestException('Sensitive access approval object does not match');
  }

  const now = input.now ?? new Date();
  if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
    throw new BadRequestException('Sensitive access approval has expired');
  }

  return true;
}
