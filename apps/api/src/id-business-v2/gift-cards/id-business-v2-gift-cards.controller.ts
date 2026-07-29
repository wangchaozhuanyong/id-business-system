import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2OptionsService } from '../options/public-api';
import type { ConfirmIdBusinessV2GiftCardCreditDto } from './dto/confirm-id-business-v2-gift-card-credit.dto';
import type { ReverseIdBusinessV2GiftCardDto } from './dto/reverse-id-business-v2-gift-card.dto';
import type { UpdateIdBusinessV2GiftCardMetadataDto } from './dto/update-id-business-v2-gift-card-metadata.dto';
import { IdBusinessV2GiftCardCreditService } from './id-business-v2-gift-card-credit.service';
import { IdBusinessV2GiftCardRecordsService } from './id-business-v2-gift-card-records.service';
import { IdBusinessV2GiftCardReversalService } from './id-business-v2-gift-card-reversal.service';

@Controller('id-business-v2/gift-cards')
export class IdBusinessV2GiftCardsController {
  constructor(
    private readonly giftCardCreditService: IdBusinessV2GiftCardCreditService,
    private readonly giftCardRecordsService: IdBusinessV2GiftCardRecordsService,
    private readonly giftCardReversalService: IdBusinessV2GiftCardReversalService,
    private readonly optionsService: IdBusinessV2OptionsService
  ) {}

  @Get('records/bootstrap')
  @RequirePermissions('apple.balance.view')
  async bootstrapRecords(
    @Query('tab') tab?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('accountId') accountId?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('status') status?: string,
    @Query('entryType') entryType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    const selectedTab = tab === 'ledger' ? 'ledger' : 'giftCards';
    const listPromise =
      selectedTab === 'ledger'
        ? this.giftCardRecordsService.listBalanceLedger({
            page,
            pageSize,
            keyword,
            accountId,
            countryOptionId,
            supplierOptionId,
            entryType,
            dateFrom,
            dateTo,
            sortBy,
            sortOrder
          })
        : this.giftCardRecordsService.listGiftCards({
            page,
            pageSize,
            keyword,
            accountId,
            countryOptionId,
            supplierOptionId,
            status,
            dateFrom,
            dateTo,
            sortBy,
            sortOrder
          });
    const [list, countries, suppliers] = await Promise.all([
      listPromise,
      this.optionsService.listSelectors('country'),
      this.optionsService.listSelectors('topup_supplier')
    ]);
    return {
      tab: selectedTab,
      list,
      options: {
        countries: countries.items,
        suppliers: suppliers.items
      },
      generatedAt: new Date().toISOString()
    };
  }

  @Get('records')
  @RequirePermissions('apple.balance.view')
  listRecords(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('accountId') accountId?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.giftCardRecordsService.listGiftCards({
      page,
      pageSize,
      keyword,
      accountId,
      countryOptionId,
      supplierOptionId,
      status,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder
    });
  }

  @Get('balance-ledger')
  @RequirePermissions('apple.balance.view')
  listBalanceLedger(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('accountId') accountId?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('entryType') entryType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.giftCardRecordsService.listBalanceLedger({
      page,
      pageSize,
      keyword,
      accountId,
      countryOptionId,
      supplierOptionId,
      entryType,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder
    });
  }

  @Patch(':giftCardId/metadata')
  @RequirePermissions('apple.balance.adjust')
  updateMetadata(
    @Param('giftCardId') giftCardId: string,
    @Body() dto: UpdateIdBusinessV2GiftCardMetadataDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.giftCardRecordsService.updateMetadata(giftCardId, dto, operator);
  }

  @Get(':accountId/reversible')
  @RequirePermissions('apple.balance.view')
  listReversible(@Param('accountId') accountId: string) {
    return this.giftCardReversalService.listReversible(accountId);
  }

  @Post(':accountId/credits')
  @RequirePermissions('apple.balance.topup')
  async confirmCredit(
    @Param('accountId') accountId: string,
    @Body() dto: ConfirmIdBusinessV2GiftCardCreditDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.giftCardCreditService.confirmCredit(accountId, dto, operator);
  }

  @Post(':giftCardId/reversals')
  @RequirePermissions('apple.balance.adjust')
  async reverseGiftCard(
    @Param('giftCardId') giftCardId: string,
    @Body() dto: ReverseIdBusinessV2GiftCardDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.giftCardReversalService.reverse(giftCardId, dto, operator);
  }
}
