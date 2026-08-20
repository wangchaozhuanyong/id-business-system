import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { resolveTrustedClientIp } from '../../common/http/trusted-client-ip';
import type { QueryIdBusinessV2MailViewerDto } from './dto/id-business-v2-mail-viewer.dto';
import { IdBusinessV2MailViewerService } from './id-business-v2-mail-viewer.service';

interface PublicMailRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  requestId?: string;
}

@Public()
@Controller('public/mailbox')
export class IdBusinessV2PublicMailboxController {
  constructor(private readonly mailViewerService: IdBusinessV2MailViewerService) {}

  @Post('query')
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  query(@Body() dto: QueryIdBusinessV2MailViewerDto, @Req() request?: PublicMailRequest) {
    return this.mailViewerService.query(
      dto,
      resolveTrustedClientIp(request),
      request?.requestId ?? 'public-mailbox-query'
    );
  }
}
