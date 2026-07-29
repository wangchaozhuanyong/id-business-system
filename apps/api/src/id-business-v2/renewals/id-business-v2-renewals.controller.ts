import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2ManualRenewalDto } from './dto/create-id-business-v2-manual-renewal.dto';
import type { UpdateIdBusinessV2RenewalWarningSettingsDto } from './dto/update-id-business-v2-renewal-warning-settings.dto';
import { IdBusinessV2ManualRenewalService } from './id-business-v2-manual-renewal.service';
import { IdBusinessV2RenewalWarningService } from './id-business-v2-renewal-warning.service';
import { IdBusinessV2RenewalsService } from './id-business-v2-renewals.service';

@Controller('id-business-v2/renewals')
@RequirePermissions('apple.renewal_task.view')
export class IdBusinessV2RenewalsController {
  constructor(
    private readonly renewalsService: IdBusinessV2RenewalsService,
    private readonly manualRenewalService: IdBusinessV2ManualRenewalService,
    private readonly renewalWarningService: IdBusinessV2RenewalWarningService
  ) {}

  @Get('workbench')
  listWorkbench(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('customerId') customerId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('accountId') accountId?: string,
    @Query('dueStatus') dueStatus?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('warningOnly') warningOnly?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.renewalsService.listWorkbench({
      page,
      pageSize,
      keyword,
      customerId,
      serviceOptionId,
      accountId,
      dueStatus,
      dueFrom,
      dueTo,
      warningOnly,
      sortBy,
      sortOrder
    });
  }

  @Get('workbench/bootstrap')
  async bootstrapWorkbench(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('customerId') customerId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('accountId') accountId?: string,
    @Query('dueStatus') dueStatus?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('warningOnly') warningOnly?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    const canRenew =
      operator?.permissions.includes('apple.renewal_task.update') &&
      operator.permissions.includes('apple.order.create');
    const [list, filters, manualOptions] = await Promise.all([
      this.renewalsService.listWorkbench({
        page,
        pageSize,
        keyword,
        customerId,
        serviceOptionId,
        accountId,
        dueStatus,
        dueFrom,
        dueTo,
        warningOnly,
        sortBy,
        sortOrder
      }),
      this.renewalsService.listFilterOptions(),
      canRenew ? this.manualRenewalService.listOptions() : Promise.resolve(null)
    ]);
    return {
      list,
      options: {
        filters,
        manualRenewal: manualOptions
      },
      generatedAt: new Date().toISOString()
    };
  }

  @Get('workbench/filter-options')
  listFilterOptions() {
    return this.renewalsService.listFilterOptions();
  }

  @Get('workbench/manual-renewal-options')
  @RequirePermissions('apple.renewal_task.view', 'apple.renewal_task.update', 'apple.order.create')
  listManualRenewalOptions() {
    return this.manualRenewalService.listOptions();
  }

  @Get('warning-settings')
  getWarningSettings() {
    return this.renewalWarningService.getSettings();
  }

  @Patch('warning-settings')
  @RequirePermissions(
    'apple.renewal_task.view',
    'apple.renewal_task.update',
    'id_business_v2.renewal_warning.manage'
  )
  updateWarningSettings(
    @Body() dto: UpdateIdBusinessV2RenewalWarningSettingsDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.renewalWarningService.updateSettings(dto, operator);
  }

  @Get('warning-summary')
  getWarningSummary() {
    return this.renewalWarningService.getSummary();
  }

  @Post(':activationId/manual-renewals')
  @RequirePermissions('apple.renewal_task.view', 'apple.renewal_task.update', 'apple.order.create')
  createManualRenewal(
    @Param('activationId') activationId: string,
    @Body() dto: CreateIdBusinessV2ManualRenewalDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.manualRenewalService.create(activationId, dto, operator);
  }
}
