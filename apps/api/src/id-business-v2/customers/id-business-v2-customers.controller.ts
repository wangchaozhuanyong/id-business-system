import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common';
import { CurrentUser, RequirePermissions } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2CustomerDto } from './dto/create-id-business-v2-customer.dto';
import type { RevealIdBusinessV2CustomerPhoneDto } from './dto/reveal-id-business-v2-customer-phone.dto';
import type { UpdateIdBusinessV2CustomerDto } from './dto/update-id-business-v2-customer.dto';
import { IdBusinessV2OptionsService } from '../options/public-api';
import { IdBusinessV2CustomersService } from './id-business-v2-customers.service';

interface RequestWithAuditMeta {
  ip?: string;
  requestId?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Controller('id-business-v2/customers')
export class IdBusinessV2CustomersController {
  constructor(
    private readonly customersService: IdBusinessV2CustomersService,
    private readonly optionsService: IdBusinessV2OptionsService
  ) {}

  @Get()
  @RequirePermissions('customer.view')
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('sourceOptionId') sourceOptionId?: string,
    @Query('tagOptionId') tagOptionId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('recordStatus') recordStatus?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.customersService.list(
      {
        page,
        pageSize,
        keyword,
        sourceOptionId,
        tagOptionId,
        serviceOptionId,
        recordStatus,
        sortBy,
        sortOrder
      },
      operator
    );
  }

  @Get('bootstrap')
  @RequirePermissions('customer.view')
  async bootstrap(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('keyword') keyword?: string,
    @Query('sourceOptionId') sourceOptionId?: string,
    @Query('tagOptionId') tagOptionId?: string,
    @Query('serviceOptionId') serviceOptionId?: string,
    @Query('recordStatus') recordStatus?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    const [list, optionGroups] = await Promise.all([
      this.customersService.list(
        {
          page,
          pageSize,
          keyword,
          sourceOptionId,
          tagOptionId,
          serviceOptionId,
          recordStatus,
          sortBy,
          sortOrder
        },
        operator
      ),
      this.optionsService.listSelectorGroups(['customer_source', 'customer_tag', 'service'])
    ]);
    return {
      list,
      options: {
        sources: optionGroups.customer_source.items,
        tags: optionGroups.customer_tag.items,
        services: optionGroups.service.items
      },
      generatedAt: new Date().toISOString()
    };
  }

  @Get(':id/delete-preview')
  @RequirePermissions('customer.view')
  getDeletePreview(@Param('id') id: string) {
    return this.customersService.getDeletePreview(id);
  }

  @Get(':id')
  @RequirePermissions('customer.view')
  get(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.customersService.get(id, operator);
  }

  @Post()
  @RequirePermissions('customer.create')
  create(
    @Body() dto: CreateIdBusinessV2CustomerDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.create(dto, operator, this.requestMeta(request));
  }

  @Patch(':id')
  @RequirePermissions('customer.update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2CustomerDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.update(id, dto, operator, this.requestMeta(request));
  }

  @Post(':id/reveal-phone')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @RequirePermissions('customer.view_phone')
  revealPhone(
    @Param('id') id: string,
    @Body() dto: RevealIdBusinessV2CustomerPhoneDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.revealPhone(id, dto, operator, this.requestMeta(request));
  }

  @Post(':id/reveal-whatsapp')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @RequirePermissions('customer.view_phone')
  revealWhatsapp(
    @Param('id') id: string,
    @Body() dto: RevealIdBusinessV2CustomerPhoneDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.revealWhatsapp(id, dto, operator, this.requestMeta(request));
  }

  @Post(':id/reveal-wechat')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @RequirePermissions('customer.view_phone')
  revealWechat(
    @Param('id') id: string,
    @Body() dto: RevealIdBusinessV2CustomerPhoneDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.revealWechat(id, dto, operator, this.requestMeta(request));
  }

  @Post(':id/reveal-qq')
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @RequirePermissions('customer.view_phone')
  revealQq(
    @Param('id') id: string,
    @Body() dto: RevealIdBusinessV2CustomerPhoneDto,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.revealQq(id, dto, operator, this.requestMeta(request));
  }

  @Delete(':id')
  @RequirePermissions('customer.delete')
  remove(
    @Param('id') id: string,
    @Query('previewFingerprint') previewFingerprint: string | undefined,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Req() request: RequestWithAuditMeta
  ) {
    return this.customersService.remove(
      id,
      previewFingerprint,
      operator,
      this.requestMeta(request)
    );
  }

  private requestMeta(request: RequestWithAuditMeta) {
    return {
      requestId: request.requestId,
      ip: request.ip,
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    };
  }

  private getHeaderValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value.join(', ') : value;
  }
}
