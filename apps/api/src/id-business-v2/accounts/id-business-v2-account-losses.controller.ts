import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { ReportIdBusinessV2AccountLossDto } from './dto/report-id-business-v2-account-loss.dto';
import { IdBusinessV2AccountLossesService } from './id-business-v2-account-losses.service';

@Controller('id-business-v2/accounts')
export class IdBusinessV2AccountLossCommandsController {
  constructor(private readonly accountLossesService: IdBusinessV2AccountLossesService) {}

  @Post(':id/report-loss')
  @RequirePermissions('apple.account.update', 'apple.balance.adjust')
  reportLoss(
    @Param('id') id: string,
    @Body() dto: ReportIdBusinessV2AccountLossDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: { requestId?: string }
  ) {
    return this.accountLossesService.reportLoss(id, dto, operator, {
      requestId: request?.requestId
    });
  }
}

@Controller('id-business-v2/account-losses')
export class IdBusinessV2AccountLossesController {
  constructor(private readonly accountLossesService: IdBusinessV2AccountLossesService) {}

  @Get()
  @RequirePermissions('apple.balance.view')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('saleState') saleState?: string,
    @Query('reportedFrom') reportedFrom?: string,
    @Query('reportedTo') reportedTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.accountLossesService.list({
      page,
      pageSize,
      keyword,
      countryOptionId,
      saleState,
      reportedFrom,
      reportedTo,
      sortBy,
      sortOrder
    });
  }
}
