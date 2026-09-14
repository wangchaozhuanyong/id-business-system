import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { resolveTrustedClientIp } from '../../common/http/trusted-client-ip';
import type { QueryIdBusinessV2VendureMailboxDto } from './dto/id-business-v2-vendure-mailbox.dto';
import { IdBusinessV2VendureMailboxService } from './id-business-v2-vendure-mailbox.service';

@Public()
@Controller('id-business-v2/public/vendure-mailbox')
export class IdBusinessV2PublicVendureMailboxController {
  constructor(private readonly service: IdBusinessV2VendureMailboxService) {}

  @Post('query')
  @Header('Cache-Control', 'private, no-store')
  query(@Body() dto: QueryIdBusinessV2VendureMailboxDto, @Req() request?: { ip?: string | null }) {
    return this.service.publicQuery(dto, resolveTrustedClientIp(request));
  }
}
