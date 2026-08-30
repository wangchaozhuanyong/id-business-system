import { Controller, Header, Sse } from '@nestjs/common';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { IdBusinessV2ChangeSyncService } from './id-business-v2-change-sync.service';

@Controller('realtime')
export class IdBusinessV2RealtimeController {
  constructor(private readonly changeSyncService: IdBusinessV2ChangeSyncService) {}

  @Sse('events')
  @SkipApiResponse()
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  events() {
    return this.changeSyncService.streamEvents();
  }
}
