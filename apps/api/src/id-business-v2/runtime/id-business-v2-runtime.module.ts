import { Module } from '@nestjs/common';
import { V2CommandTransactionManager } from './id-business-v2-command-transaction.service';
import { V2TransactionalAuditService } from './persistence/id-business-v2-transactional-audit.repository';

@Module({
  providers: [V2CommandTransactionManager, V2TransactionalAuditService],
  exports: [V2CommandTransactionManager, V2TransactionalAuditService]
})
export class IdBusinessV2RuntimeModule {}
