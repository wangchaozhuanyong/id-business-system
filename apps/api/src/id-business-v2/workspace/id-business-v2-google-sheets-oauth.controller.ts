import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { IdBusinessV2GoogleSheetsSyncService } from './id-business-v2-google-sheets-sync.service';
import { IdBusinessV2GoogleSheetsSyncWorker } from './id-business-v2-google-sheets-sync.worker';

@Public()
@Controller('public/google-sheets-sync/oauth')
export class IdBusinessV2GoogleSheetsOAuthController {
  constructor(
    private readonly service: IdBusinessV2GoogleSheetsSyncService,
    private readonly worker: IdBusinessV2GoogleSheetsSyncWorker
  ) {}

  @Get('callback')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @SkipApiResponse()
  async callback(@Query() query: { code?: unknown; error?: unknown; state?: unknown }) {
    const succeeded = await this.service.completeAuthorization(query).catch(() => false);
    if (succeeded) void this.worker.runNow(true).catch(() => undefined);
    const title = succeeded ? 'Google 表格授权完成' : 'Google 表格授权失败';
    const detail = succeeded
      ? '系统正在创建并同步业务报表，请返回管理系统查看同步状态。'
      : '授权状态无效或已过期，请返回管理系统后重新授权。';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:40px;color:#182230"><h1 style="font-size:20px">${title}</h1><p>${detail}</p></body></html>`;
  }
}
