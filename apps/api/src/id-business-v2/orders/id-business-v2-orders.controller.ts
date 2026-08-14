import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2OptionsService } from '../options/public-api';
import type { CancelIdBusinessV2OrderDto } from './dto/cancel-id-business-v2-order.dto';
import type { ConsumeIdBusinessV2OrderDto } from './dto/consume-id-business-v2-order.dto';
import type { CreateIdBusinessV2OrderDto } from './dto/create-id-business-v2-order.dto';
import type { DeleteIdBusinessV2OrderDto } from './dto/delete-id-business-v2-order.dto';
import type { QuoteIdBusinessV2OrderReceiptFxDto } from './dto/quote-id-business-v2-order-receipt-fx.dto';
import type { RecoverIdBusinessV2SoldAccountDto } from './dto/recover-id-business-v2-sold-account.dto';
import type { RefundIdBusinessV2OrderDto } from './dto/refund-id-business-v2-order.dto';
import type { SearchIdBusinessV2OrderCandidatesDto } from './dto/search-id-business-v2-order-candidates.dto';
import type { UpdateIdBusinessV2OrderDto } from './dto/update-id-business-v2-order.dto';
import { IdBusinessV2OrderCompletionService } from './id-business-v2-order-completion.service';
import { IdBusinessV2OrderConsumptionService } from './id-business-v2-order-consumption.service';
import { IdBusinessV2OrderEntryService } from './id-business-v2-order-entry.service';
import { IdBusinessV2OrderLifecycleService } from './id-business-v2-order-lifecycle.service';
import { IdBusinessV2OrderMatchingService } from './id-business-v2-order-matching.service';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';

@Controller('id-business-v2/orders')
export class IdBusinessV2OrdersController {
  constructor(
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly orderMatchingService: IdBusinessV2OrderMatchingService,
    private readonly orderEntryService: IdBusinessV2OrderEntryService,
    private readonly orderConsumptionService: IdBusinessV2OrderConsumptionService,
    private readonly orderCompletionService: IdBusinessV2OrderCompletionService,
    private readonly orderLifecycleService: IdBusinessV2OrderLifecycleService,
    private readonly optionsService: IdBusinessV2OptionsService
  ) {}

  @Get()
  @RequirePermissions('apple.order.view')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('customerId') customerId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('accountId') accountId?: string,
    @Query('settlementPlatformOptionId') settlementPlatformOptionId?: string,
    @Query('status') status?: string,
    @Query('accountDisposition') accountDisposition?: string,
    @Query('accountSource') accountSource?: string,
    @Query('openedFrom') openedFrom?: string,
    @Query('openedTo') openedTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.ordersService.list(
      {
        page,
        pageSize,
        keyword,
        customerId,
        serviceOptionId,
        accountId,
        settlementPlatformOptionId,
        status,
        accountDisposition,
        accountSource,
        openedFrom,
        openedTo,
        sortBy,
        sortOrder
      },
      operator
    );
  }

  @Get('bootstrap')
  @RequirePermissions('apple.order.view')
  async bootstrap(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('customerId') customerId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('accountId') accountId?: string,
    @Query('settlementPlatformOptionId') settlementPlatformOptionId?: string,
    @Query('status') status?: string,
    @Query('accountDisposition') accountDisposition?: string,
    @Query('accountSource') accountSource?: string,
    @Query('openedFrom') openedFrom?: string,
    @Query('openedTo') openedTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    const [list, optionGroups] = await Promise.all([
      this.ordersService.list(
        {
          page,
          pageSize,
          keyword,
          customerId,
          serviceOptionId,
          accountId,
          settlementPlatformOptionId,
          status,
          accountDisposition,
          accountSource,
          openedFrom,
          openedTo,
          sortBy,
          sortOrder
        },
        operator
      ),
      this.optionsService.listSelectorGroups(['service', 'settlement_platform'])
    ]);
    return {
      list,
      options: {
        services: optionGroups.service.items,
        settlementPlatforms: optionGroups.settlement_platform.items
      },
      generatedAt: new Date().toISOString()
    };
  }

  @Get('matching-candidates')
  @RequirePermissions('apple.order.create')
  findMatchingCandidates(
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('accountSource') accountSource?: string,
    @Query('customerId') customerId?: string,
    @Query('balanceAmount') balanceAmount?: string,
    @Query('orderId') orderId?: string,
    @Query('limit') limit?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderMatchingService.findCandidates(
      {
        serviceOptionId,
        accountSource,
        customerId,
        balanceAmount,
        orderId,
        limit
      },
      operator
    );
  }

  @Post('manual-candidates/search')
  @RequirePermissions('apple.order.create')
  searchManualCandidates(
    @Body() dto: SearchIdBusinessV2OrderCandidatesDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderMatchingService.searchManualCandidates(dto, operator);
  }

  @Get('entry-options')
  @RequirePermissions('apple.order.create')
  getEntryOptions(
    @Query('customerKeyword') customerKeyword?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderEntryService.getEntryOptions(customerKeyword, operator);
  }

  @Post('receipt-fx-quote')
  @RequirePermissions('apple.order.create')
  quoteReceiptFx(
    @Body() dto: QuoteIdBusinessV2OrderReceiptFxDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderEntryService.quoteReceiptFx(dto, operator);
  }

  @Post()
  @RequirePermissions('apple.order.create')
  create(@Body() dto: CreateIdBusinessV2OrderDto, @CurrentUser() operator?: AuthenticatedUser) {
    return this.orderEntryService.create(dto, operator);
  }

  @Post(':id/consume-balance')
  @RequirePermissions('apple.order.create')
  consumeBalance(
    @Param('id') id: string,
    @Body() dto: ConsumeIdBusinessV2OrderDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderConsumptionService.consume(id, dto, operator);
  }

  @Post(':id/complete')
  @RequirePermissions('apple.order.update')
  complete(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.orderCompletionService.complete(id, operator);
  }

  @Patch(':id')
  @RequirePermissions('apple.order.update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2OrderDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderLifecycleService.update(id, dto, operator);
  }

  @Post(':id/refund')
  @RequirePermissions('apple.order.update')
  refund(
    @Param('id') id: string,
    @Body() dto: RefundIdBusinessV2OrderDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderLifecycleService.refund(id, dto, operator);
  }

  @Post(':id/cancel')
  @RequirePermissions('apple.order.update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelIdBusinessV2OrderDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderLifecycleService.cancel(id, dto, operator);
  }

  @Delete(':id')
  @RequirePermissions('apple.order.delete')
  remove(
    @Param('id') id: string,
    @Body() dto: DeleteIdBusinessV2OrderDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderLifecycleService.remove(id, dto, operator);
  }

  @Get(':id/recover-sold-account-preview')
  @RequirePermissions('apple.account.update')
  previewSoldAccountRecovery(@Param('id') id: string, @Query('accountId') accountId: string) {
    return this.orderLifecycleService.previewSoldAccountRecovery(id, accountId);
  }

  @Post(':id/recover-sold-account')
  @RequirePermissions('apple.account.update')
  recoverSoldAccount(
    @Param('id') id: string,
    @Body() dto: RecoverIdBusinessV2SoldAccountDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.orderLifecycleService.recoverSoldAccount(id, dto, operator);
  }

  @Get(':id')
  @RequirePermissions('apple.order.view')
  get(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.ordersService.get(id, operator);
  }
}
