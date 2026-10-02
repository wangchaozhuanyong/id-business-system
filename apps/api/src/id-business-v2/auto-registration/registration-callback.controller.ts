import { Body, Controller, Header, Headers, Param, Post } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { RegistrationEventsService } from './registration-events.service';

@Public()
@Controller('id-business-v2/auto-registration/local')
export class RegistrationCallbackController {
  constructor(private readonly events: RegistrationEventsService) {}
  @Post(':id')
  @Header('Cache-Control', 'no-store')
  event(
    @Param('id') jobId: string,
    @Headers('x-registration-task') token: unknown,
    @Body() value: unknown
  ) {
    return this.events.event(jobId, token, value);
  }
}
