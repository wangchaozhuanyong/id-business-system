import { Body, Controller, Header, Headers, Param, Post } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { BrowserRegistrationService } from './browser-registration.service';

@Controller('id-business-v2/auto-registration/browser/tasks')
@Public()
export class BrowserRegistrationController {
  constructor(private readonly service: BrowserRegistrationService) {}

  @Post(':id/:action')
  @Header('Cache-Control', 'private, no-store')
  callback(
    @Param('id') id: string,
    @Param('action') action: 'claim' | 'event' | 'code' | 'result' | 'fail',
    @Headers('authorization') authorization: unknown,
    @Headers('x-registration-browser-nonce') nonce: unknown,
    @Body() body: unknown
  ) {
    return this.service.callback(id, action, authorization, nonce, body);
  }
}
