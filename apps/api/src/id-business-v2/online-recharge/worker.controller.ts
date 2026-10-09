import { Body, Controller, Header, Headers, Post, Req } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { OnlineRechargeWorkerService } from './worker.service';
import { OnlineRechargeWebhooksService } from './webhooks.service';

@Controller('id-business-v2/online-recharge')
@Public()
export class OnlineRechargeWorkerController {
  constructor(
    private readonly workers: OnlineRechargeWorkerService,
    private readonly webhooks: OnlineRechargeWebhooksService
  ) {}
  @Post('worker/rpc')
  @SkipApiResponse()
  @Header('Cache-Control', 'no-store')
  rpc(@Headers('x-online-recharge-worker') key: unknown, @Body() input: unknown) {
    return this.workers.rpc(key, input);
  }
  @Post('external/cards/push')
  @Header('Cache-Control', 'no-store')
  push(@Headers('x-api-key') key: unknown, @Body() input: unknown) {
    return this.webhooks.push(key, input);
  }
  @Post('webhooks/card-issue')
  @Header('Cache-Control', 'no-store')
  cardIssue(
    @Body() input: unknown,
    @Req() request: { rawBody?: Buffer; headers: Record<string, string | string[] | undefined> }
  ) {
    return this.webhooks.receive(request.headers, input, request.rawBody);
  }
}
