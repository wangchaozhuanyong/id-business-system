import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { MailEvent } from '../mail-event';

@Injectable()
export class MailEventRepository {
  constructor(private readonly prisma: PrismaService) {}
  find(id: string) {
    return this.prisma.idBusinessV2MailboxEvent.findUnique({ where: { id } });
  }
  pending() {
    return this.prisma.idBusinessV2MailboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { receivedAt: 'asc' },
      take: 100
    });
  }
  create(tx: V2CommandTransaction, event: MailEvent, payloadHash: string) {
    return tx.idBusinessV2MailboxEvent.create({
      data: {
        id: event.eventId,
        payloadHash,
        primaryAccountId: event.primaryAccountId,
        virtualEmailId: event.virtualEmailId
      }
    });
  }
  processed(id: string) {
    // Operational delivery checkpoint; the receipt and scope version were committed together.
    return this.prisma.idBusinessV2MailboxEvent.updateMany({
      where: { id, processedAt: null },
      data: { processedAt: new Date() }
    });
  }
}
