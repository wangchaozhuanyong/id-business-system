import { Body, Controller, Header, Headers, Param, Post, Req } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { OnlineRechargeVendureIntegration } from './vendure-integration.service';
import { OnlineRechargeTaskNotAccepted } from './task-acceptance';

@Controller('id-business-v2/online-recharge/integrations/vendure')
@Public()
export class OnlineRechargeVendureController {
  constructor(private readonly integration: OnlineRechargeVendureIntegration) {}
  @Post(':action')
  @SkipApiResponse()
  @Header('Cache-Control', 'no-store')
  async execute(
    @Param('action') action: string,
    @Headers('x-vendure-recharge-key') key: unknown,
    @Headers('x-vendure-client-ip') clientIp: unknown,
    @Body() body: unknown,
    @Req() request: { ip?: string }
  ) {
    this.integration.authorize(key, request.ip);
    try {
      return await this.integration.execute(action, body, clientIp);
    } catch (error) {
      // Only explicit pre-dispatch validation / rolled-back transactions prove non-acceptance.
      if (action === 'submit' && error instanceof OnlineRechargeTaskNotAccepted)
        return { rejected: true };
      throw error;
    }
  }
}
