import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2DataGovernanceApprovalService } from './id-business-v2-data-governance-approval.service';
import { IdBusinessV2DataGovernanceController } from './id-business-v2-data-governance.controller';
import { IdBusinessV2DataGovernanceExecutionService } from './id-business-v2-data-governance-execution.service';
import { IdBusinessV2DataGovernanceItemExecutorService } from './id-business-v2-data-governance-item-executor.service';
import { IdBusinessV2DataGovernancePreviewService } from './id-business-v2-data-governance-preview.service';
import { IdBusinessV2DataGovernanceQueryService } from './id-business-v2-data-governance-query.service';
import { IdBusinessV2DataGovernanceService } from './id-business-v2-data-governance.service';
import { IdBusinessV2DataGovernanceRepository } from './persistence/id-business-v2-data-governance.repository';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2DataGovernanceController],
  providers: [
    IdBusinessV2DataGovernanceService,
    IdBusinessV2DataGovernanceRepository,
    IdBusinessV2DataGovernanceQueryRepository,
    IdBusinessV2DataGovernanceQueryService,
    IdBusinessV2DataGovernancePreviewService,
    IdBusinessV2DataGovernanceApprovalService,
    IdBusinessV2DataGovernanceItemExecutorService,
    IdBusinessV2DataGovernanceExecutionService
  ]
})
export class IdBusinessV2DataGovernanceModule {}
