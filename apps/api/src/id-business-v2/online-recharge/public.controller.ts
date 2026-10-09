import {
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Injectable,
  Post,
  Req
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Public } from '../../auth/auth.decorators';
import { OnlineRechargeTasksService } from './tasks.service';

@Injectable()
export class OnlineRechargePublicLimiter {
  private readonly limits = new Map<string, { until: number; count: number }>();
  check(ip: string | undefined) {
    const now = Date.now(),
      key = createHash('sha256')
        .update(ip ?? 'unknown')
        .digest('hex');
    for (const [key, item] of this.limits) if (item.until <= now) this.limits.delete(key);
    const row = this.limits.get(key) ?? { until: now + 60000, count: 0 };
    row.count++;
    if (row.count > 90 || (!this.limits.has(key) && this.limits.size >= 10000))
      throw new HttpException('请求频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    this.limits.set(key, row);
  }
}

@Controller('id-business-v2/online-recharge/public')
@Public()
export class OnlineRechargePublicController {
  constructor(
    private readonly tasks: OnlineRechargeTasksService,
    private readonly limits: OnlineRechargePublicLimiter
  ) {}
  @Get('config') @Header('Cache-Control', 'no-store') config() {
    return this.tasks.publicConfig();
  }
  @Post('verify')
  @Header('Cache-Control', 'no-store')
  verify(@Body() input: unknown, @Req() request: { ip?: string }) {
    this.limits.check(request.ip);
    return this.tasks.verify(input);
  }
  @Post('query')
  @Header('Cache-Control', 'no-store')
  query(@Body() input: unknown, @Req() request: { ip?: string }) {
    this.limits.check(request.ip);
    return this.tasks.query(input);
  }
  @Post('redeem')
  @Header('Cache-Control', 'no-store')
  redeem(@Body() input: unknown, @Req() request: { ip?: string }) {
    this.limits.check(request.ip);
    return this.tasks.start(input, undefined, 'recharge', true);
  }
  @Post('subscription')
  @Header('Cache-Control', 'no-store')
  subscription(@Body() input: unknown, @Req() request: { ip?: string }) {
    this.limits.check(request.ip);
    return this.tasks.start(input, undefined, 'subscription', true);
  }
  @Post('task')
  @Header('Cache-Control', 'no-store')
  task(@Body() input: unknown, @Req() request: { ip?: string }) {
    this.limits.check(request.ip);
    return this.tasks.publicTask(input);
  }
  @Post('subscribe')
  @Header('Cache-Control', 'no-store')
  subscribe(@Body() input: unknown, @Req() request: { ip?: string }) {
    this.limits.check(request.ip);
    return this.tasks.publicTicket(input);
  }
}
