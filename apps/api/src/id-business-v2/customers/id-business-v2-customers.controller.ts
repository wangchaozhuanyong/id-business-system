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
    @Query('sortOrder') sortOrder?: string
  ) {
    return this.customersService.list({
      page,
      pageSize,
      keyword,
      sourceOptionId,
      tagOptionId,
      serviceOptionId,
      recordStatus,
      sortBy,
      sortOrder
    });
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
    @Query('sortOrder') sortOrder?: string
  ) {
    const [list, sources, tags, services] = await Promise.all([
      this.customersService.list({
        page,
        pageSize,
        keyword,
        sourceOptionId,
        tagOptionId,
        serviceOptionId,
        recordStatus,
        sortBy,
        sortOrder
      }),
      this.optionsService.listSelectors('customer_source'),
      this.optionsService.listSelectors('customer_tag'),
      this.optionsService.listSelectors('service')
    ]);
    return {
      list,
      options: {
        sources: sources.items,
        tags: tags.items,
        services: services.items
      },
      generatedAt: new Date().toISOString()
    };
  }

  @Get(':id')
  @RequirePermissions('customer.view')
  get(@Param('id') id: string) {
    return this.customersService.get(id);
  }

  @Post()
  @RequirePermissions('customer.create')
  create(@Body() dto: CreateIdBusinessV2CustomerDto, @CurrentUser() operator?: AuthenticatedUser) {
    return this.customersService.create(dto, operator);
  }

  @Patch(':id')
  @RequirePermissions('customer.update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIdBusinessV2CustomerDto,
    @CurrentUser() operator?: AuthenticatedUser
  ) {
    return this.customersService.update(id, dto, operator);
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
    return this.customersService.revealPhone(id, dto, operator, {
      ip: request.ip,
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
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
    return this.customersService.revealWhatsapp(id, dto, operator, {
      ip: request.ip,
      userAgent: this.getHeaderValue(request.headers['user-agent'])
    });
  }

  @Delete(':id')
  @RequirePermissions('customer.delete')
  remove(@Param('id') id: string, @CurrentUser() operator?: AuthenticatedUser) {
    return this.customersService.remove(id, operator);
  }

  private getHeaderValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value.join(', ') : value;
  }
}
