import { Body, Controller, Header, Headers, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../auth/auth.decorators';
import { verifyMailEvent } from './mail-event';
import { MailEventsService } from './mail-events.service';

@Public()
@Controller('id-business-v2/vendure-mailboxes/events')
export class MailEventsController {
  constructor(
    private readonly events: MailEventsService,
    private readonly config: ConfigService
  ) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  receive(
    @Body() value: unknown,
    @Headers('x-mail-timestamp') timestamp: unknown,
    @Headers('x-mail-signature') signature: unknown
  ) {
    return this.events.accept(
      verifyMailEvent(
        value,
        timestamp,
        signature,
        this.config.get<string>('VENDURE_MAILBOX_WEBHOOK_SECRET')
      )
    );
  }
}
