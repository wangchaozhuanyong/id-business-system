import { Body, Controller, Header, Headers, Param, Post } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { RechargeService } from './recharge.service';
import { RechargeEmailCodeService } from './recharge-email-code.service';

@Public()
@Controller('id-business-v2/auto-recharge/internal')
export class RechargeEmailCodeController {
  constructor(
    private readonly recharge: RechargeService,
    private readonly emailCodes: RechargeEmailCodeService
  ) {}

  @Post(':id/email-code')
  @Header('Cache-Control', 'no-store')
  request(
    @Param('id') id: string,
    @Headers('x-recharge-worker') token: unknown,
    @Body() value: unknown
  ) {
    this.recharge.authorizeWorker(token);
    return this.emailCodes.request(id, value);
  }
}
