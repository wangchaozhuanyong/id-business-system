import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../../auth/auth.decorators';
import { IdBusinessV2OptionsService } from '../options/public-api';
import { IdBusinessV2TopupSupplierFundsQueryService } from '../topup-supplier-funds/public-api';
import { IdBusinessV2TopupWorkbenchService } from './id-business-v2-topup-workbench.service';

@Controller('id-business-v2/balances')
export class IdBusinessV2BalancesController {
  constructor(
    private readonly topupWorkbenchService: IdBusinessV2TopupWorkbenchService,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly supplierFundsQueryService: IdBusinessV2TopupSupplierFundsQueryService
  ) {}

  @Get('workbench')
  @RequirePermissions('apple.balance.view')
  listTopupWorkbench(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('accountSource') accountSource?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('balancePreset') balancePreset?: string,
    @Query('balanceMin') balanceMin?: string,
    @Query('balanceMax') balanceMax?: string,
    @Query('onlyNormal') onlyNormal?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.topupWorkbenchService.list({
      page,
      pageSize,
      keyword,
      accountSource,
      countryOptionId,
      balancePreset,
      balanceMin,
      balanceMax,
      onlyNormal,
      sortBy,
      sortOrder
    });
  }

  @Get('workbench/bootstrap')
  @RequirePermissions('apple.balance.view')
  async bootstrapTopupWorkbench(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('accountSource') accountSource?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('balancePreset') balancePreset?: string,
    @Query('balanceMin') balanceMin?: string,
    @Query('balanceMax') balanceMax?: string,
    @Query('onlyNormal') onlyNormal?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    const [list, optionGroups, suppliers] = await Promise.all([
      this.topupWorkbenchService.list({
        page,
        pageSize,
        keyword,
        accountSource,
        countryOptionId,
        balancePreset,
        balanceMin,
        balanceMax,
        onlyNormal,
        sortBy,
        sortOrder
      }),
      this.optionsService.listSelectorGroups(['gift_card_name', 'country']),
      this.supplierFundsQueryService.listBalanceSelectors()
    ]);
    return {
      list,
      options: {
        cardNames: optionGroups.gift_card_name.items,
        countries: optionGroups.country.items,
        suppliers
      },
      generatedAt: new Date().toISOString()
    };
  }
}
