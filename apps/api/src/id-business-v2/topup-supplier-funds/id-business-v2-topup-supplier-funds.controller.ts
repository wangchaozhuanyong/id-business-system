import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type {
  AdjustIdBusinessV2TopupSupplierFundDto,
  CreateIdBusinessV2TopupSupplierPaymentDto,
  InitializeIdBusinessV2TopupSupplierFundDto,
  ReverseIdBusinessV2TopupSupplierPaymentDto
} from './dto/topup-supplier-fund.dto';
import { IdBusinessV2TopupSupplierFundsQueryService } from './id-business-v2-topup-supplier-funds-query.service';
import { IdBusinessV2TopupSupplierFundsService } from './id-business-v2-topup-supplier-funds.service';

@Controller('id-business-v2/topup-supplier-funds')
export class IdBusinessV2TopupSupplierFundsController {
  constructor(
    private readonly fundsService: IdBusinessV2TopupSupplierFundsService,
    private readonly queryService: IdBusinessV2TopupSupplierFundsQueryService
  ) {}

  @Get('suppliers')
  @RequirePermissions('apple.topup_supplier_fund.view')
  listSuppliers(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('fundingStatus') fundingStatus?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.queryService.listSuppliers({
      page,
      pageSize,
      keyword,
      status,
      fundingStatus,
      sortBy,
      sortOrder
    });
  }

  @Get('suppliers/:supplierOptionId/ledger')
  @RequirePermissions('apple.topup_supplier_fund.view')
  listLedger(
    @Param('supplierOptionId') supplierOptionId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('entryType') entryType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.queryService.listLedger(
      supplierOptionId,
      {
        page,
        pageSize,
        entryType,
        dateFrom,
        dateTo,
        sortOrder
      },
      operator
    );
  }

  @Get('payments')
  @RequirePermissions('apple.topup_supplier_fund.view')
  listPayments(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.queryService.listPaymentRecords({
      page,
      pageSize,
      keyword,
      supplierOptionId,
      status,
      dateFrom,
      dateTo,
      sortBy,
      sortOrder
    });
  }

  @Post('suppliers/:supplierOptionId/initialize')
  @RequirePermissions('apple.topup_supplier_fund.manage')
  initialize(
    @Param('supplierOptionId') supplierOptionId: string,
    @Body() dto: InitializeIdBusinessV2TopupSupplierFundDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.fundsService.initialize(supplierOptionId, dto, operator);
  }

  @Post('suppliers/:supplierOptionId/payments')
  @RequirePermissions('apple.topup_supplier_fund.manage')
  createPayment(
    @Param('supplierOptionId') supplierOptionId: string,
    @Body() dto: CreateIdBusinessV2TopupSupplierPaymentDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.fundsService.createPayment(supplierOptionId, dto, operator);
  }

  @Post('suppliers/:supplierOptionId/adjustments')
  @RequirePermissions('apple.topup_supplier_fund.manage')
  adjust(
    @Param('supplierOptionId') supplierOptionId: string,
    @Body() dto: AdjustIdBusinessV2TopupSupplierFundDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.fundsService.adjust(supplierOptionId, dto, operator);
  }

  @Post('payments/:paymentId/reversals')
  @RequirePermissions('apple.topup_supplier_fund.manage')
  reversePayment(
    @Param('paymentId') paymentId: string,
    @Body() dto: ReverseIdBusinessV2TopupSupplierPaymentDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.fundsService.reversePayment(paymentId, dto, operator);
  }
}
