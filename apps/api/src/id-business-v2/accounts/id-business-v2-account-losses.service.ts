import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { V2CommandTransaction } from '../runtime/public-api';
import type { ReportIdBusinessV2AccountLossDto } from './dto/report-id-business-v2-account-loss.dto';
import type { UnfreezeIdBusinessV2AccountLossDto } from './dto/unfreeze-id-business-v2-account-loss.dto';
import {
  IdBusinessV2AccountLossCommandHandler,
  type IdBusinessV2AccountLossAuditContext
} from './id-business-v2-account-loss.command-handler';
import {
  IdBusinessV2AccountLossQueryService,
  type ListIdBusinessV2AccountLossesQuery
} from './id-business-v2-account-loss-query.service';

export type { IdBusinessV2AccountLossAuditContext } from './id-business-v2-account-loss.command-handler';

@Injectable()
export class IdBusinessV2AccountLossesService {
  constructor(
    private readonly commandHandler: IdBusinessV2AccountLossCommandHandler,
    private readonly queryService: IdBusinessV2AccountLossQueryService
  ) {}

  reportLoss(
    accountId: string,
    dto: ReportIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    invocation?: { requestId?: string; businessTime?: Date }
  ) {
    return this.commandHandler.reportLoss(accountId, dto, operator, invocation);
  }

  unfreezeLoss(
    accountId: string,
    dto: UnfreezeIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    invocation?: { requestId?: string; businessTime?: Date }
  ) {
    return this.commandHandler.unfreezeLoss(accountId, dto, operator, invocation);
  }

  reportLossInTransaction(
    tx: V2CommandTransaction,
    accountId: string,
    dto: ReportIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    auditContext?: IdBusinessV2AccountLossAuditContext,
    outerContext?: { requestId?: string; businessTime?: Date }
  ) {
    return this.commandHandler.reportLossInTransaction(
      tx,
      accountId,
      dto,
      operator,
      auditContext,
      outerContext
    );
  }

  list(query: ListIdBusinessV2AccountLossesQuery) {
    return this.queryService.list(query);
  }
}
