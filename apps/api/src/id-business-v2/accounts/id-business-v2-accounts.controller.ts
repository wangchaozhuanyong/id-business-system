import { Body, Controller, Get, Header, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { resolveTrustedClientIp } from '../../common/http/trusted-client-ip';
import type { ChangeIdBusinessV2AccountStatusDto } from './dto/change-id-business-v2-account-status.dto';
import type { CreateIdBusinessV2AccountDto } from './dto/create-id-business-v2-account.dto';
import type { ImportIdBusinessV2AccountsDto } from './dto/import-id-business-v2-accounts.dto';
import type { RevealIdBusinessV2AccountSecretDto } from './dto/reveal-id-business-v2-account-secret.dto';
import type { UpdateIdBusinessV2AccountDto } from './dto/update-id-business-v2-account.dto';
import { IdBusinessV2OptionsService } from '../options/public-api';
import { IdBusinessV2AccountsService } from './id-business-v2-accounts.service';

interface RequestWithAuditMeta {
  ip?: string;
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('id-business-v2/accounts')
export class IdBusinessV2AccountsController {
  constructor(
    private readonly accountsService: IdBusinessV2AccountsService,
    private readonly optionsService: IdBusinessV2OptionsService
  ) {}

  @Get()
  @RequirePermissions('apple.account.view')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('statusOptionId') statusOptionId?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('recordStatus') recordStatus?: string,
    @Query('saleState') saleState?: string,
    @Query('lifecycle') lifecycle?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.accountsService.list(
      {
        page,
        pageSize,
        keyword,
        countryOptionId,
        statusOptionId,
        supplierOptionId,
        recordStatus,
        saleState,
        lifecycle,
        sortBy,
        sortOrder
      },
      operator
    );
  }

  @Get('bootstrap')
  @RequirePermissions('apple.account.view')
  async bootstrap(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('statusOptionId') statusOptionId?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('recordStatus') recordStatus?: string,
    @Query('saleState') saleState?: string,
    @Query('lifecycle') lifecycle?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    const [list, optionGroups] = await Promise.all([
      this.accountsService.list(
        {
          page,
          pageSize,
          keyword,
          countryOptionId,
          statusOptionId,
          supplierOptionId,
          recordStatus,
          saleState,
          lifecycle,
          sortBy,
          sortOrder
        },
        operator
      ),
      this.optionsService.listSelectorGroups(['country', 'id_status', 'id_supplier'])
    ]);
    return {
      list,
      options: {
        countries: optionGroups.country.items,
        statuses: optionGroups.id_status.items,
        suppliers: optionGroups.id_supplier.items
      },
      generatedAt: new Date().toISOString()
    };
  }

  @Get('export')
  @RequirePermissions('apple.account.view')
  exportRows(
    @Query('keyword') keyword?: string,
    @Query('countryOptionId') countryOptionId?: string,
    @Query('statusOptionId') statusOptionId?: string,
    @Query('supplierOptionId') supplierOptionId?: string,
    @Query('recordStatus') recordStatus?: string,
    @Query('saleState') saleState?: string,
    @Query('lifecycle') lifecycle?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: RequestWithAuditMeta
  ) {
    return this.accountsService.exportRows(
      {
        keyword,
        countryOptionId,
        statusOptionId,
        supplierOptionId,
        recordStatus,
        saleState,
        lifecycle,
        sortBy,
        sortOrder
      },
      operator,
      { requestId: request?.requestId }
    );
  }

  @Get('purchase-sources')
  @RequirePermissions('apple.account.view', 'apple.account.create')
  listPurchaseSources() {
    return this.accountsService.listPurchaseSources();
  }

  @Get(':id')
  @RequirePermissions('apple.account.view')
  get(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.accountsService.get(id, operator);
  }

  @Post()
  @RequirePermissions('apple.account.create')
  create(
    @Body() dto: CreateIdBusinessV2AccountDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: RequestWithAuditMeta
  ) {
    return this.accountsService.create(dto, operator, { requestId: request?.requestId });
  }

  @Post('import')
  @RequirePermissions('apple.account.import')
  importRows(
    @Body() dto: ImportIdBusinessV2AccountsDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: RequestWithAuditMeta
  ) {
    return this.accountsService.importRows(dto, operator, { requestId: request?.requestId });
  }

  @Patch(':id')
  @RequirePermissions('apple.account.update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2AccountDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: RequestWithAuditMeta
  ) {
    return this.accountsService.update(id, dto, operator, { requestId: request?.requestId });
  }

  @Post(':id/record-status')
  @RequirePermissions('apple.account.update')
  changeRecordStatus(
    @Param('id') id: string,
    @Body() dto: ChangeIdBusinessV2AccountStatusDto,
    @CurrentUser() operator?: AuthenticatedUser,
    @Req() request?: RequestWithAuditMeta
  ) {
    return this.accountsService.changeRecordStatus(id, dto, operator, {
      requestId: request?.requestId
    });
  }

  @Post(':id/reveal-secret')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @RequirePermissions('apple.account.view')
  revealSecret(
    @Param('id') id: string,
    @Body() dto: RevealIdBusinessV2AccountSecretDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.accountsService.revealSecret(id, dto, operator, {
      requestId: request.requestId,
      ip: resolveTrustedClientIp(request),
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
  }

  private getHeaderValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value.join(', ') : value;
  }
}
