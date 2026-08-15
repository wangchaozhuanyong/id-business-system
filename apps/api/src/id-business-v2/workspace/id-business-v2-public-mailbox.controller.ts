import { Body, Controller, Header, Post, Req } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import type { QueryIdBusinessV2MailViewerDto } from './dto/id-business-v2-mail-viewer.dto';
import { IdBusinessV2MailViewerService } from './id-business-v2-mail-viewer.service';

interface PublicMailRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}

@Public()
@Controller('public/mailbox')
export class IdBusinessV2PublicMailboxController {
  constructor(private readonly mailViewerService: IdBusinessV2MailViewerService) {}

  @Post('query')
  @Header('Cache-Control', 'private, no-store')
  @Header('Pragma', 'no-cache')
  query(@Body() dto: QueryIdBusinessV2MailViewerDto, @Req() request?: PublicMailRequest) {
    return this.mailViewerService.query(dto, this.readRequestIp(request));
  }

  private readRequestIp(request?: PublicMailRequest) {
    const connectingIp = request?.headers?.['cf-connecting-ip'];
    const realIp = request?.headers?.['x-real-ip'];
    const forwardedIp = request?.headers?.['x-forwarded-for'];
    const candidate = connectingIp ?? realIp ?? forwardedIp ?? request?.ip;
    return Array.isArray(candidate) ? candidate[0] : candidate;
  }
}
