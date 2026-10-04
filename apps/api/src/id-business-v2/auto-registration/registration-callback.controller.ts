import { Body, Controller, Header, Headers, Param, Post } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { RegistrationEventsService } from './registration-events.service';
import { RegistrationJobsService } from './registration-jobs.service';
import { V2IdentityService } from '../../v2-auth/v2-identity.service';
import { record } from './registration-validation';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { RegistrationMailDeliveryService } from './registration-mail-delivery.service';

@Public()
@Controller('id-business-v2/auto-registration/local')
export class RegistrationCallbackController {
  constructor(
    private readonly events: RegistrationEventsService,
    private readonly jobs: RegistrationJobsService,
    private readonly identity: V2IdentityService,
    private readonly mailDelivery: RegistrationMailDeliveryService
  ) {}
  @Post(':id/code')
  @Header('Cache-Control', 'no-store')
  async code(
    @Param('id') jobId: string,
    @Headers('x-registration-task') token: unknown,
    @Body() value: unknown
  ) {
    const input = record(value);
    if (Object.keys(input).some((key) => key !== 'attempt'))
      throw new BadRequestException('任务请求包含未知字段');
    const row = await this.jobs.authorized(jobId, token, input.attempt);
    const operator = await this.identity.getAuthenticatedUser(row.ownerId);
    if (!operator.roles.includes('admin') || operator.mustResetPassword)
      throw new ForbiddenException('管理员授权已失效');
    return this.jobs.code(jobId, operator);
  }
  @Post(':id')
  @Header('Cache-Control', 'no-store')
  async event(
    @Param('id') jobId: string,
    @Headers('x-registration-task') token: unknown,
    @Body() value: unknown
  ) {
    const result = await this.events.event(jobId, token, value);
    if (record(value).type === 'waiting_email') {
      // A single lookup on entering the challenge also covers mail that arrived
      // before subscription/restart. Later reads are driven by mail events.
      this.mailDelivery.request(jobId);
    }
    return result;
  }
}
