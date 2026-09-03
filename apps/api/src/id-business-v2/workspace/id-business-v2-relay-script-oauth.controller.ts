import { Controller, Get, Header, Query } from '@nestjs/common';
import { Public } from '../../auth/auth.decorators';
import { SkipApiResponse } from '../../common/interceptors/skip-api-response.decorator';
import { IdBusinessV2RelayScriptService } from './id-business-v2-relay-script.service';

@Public()
@Controller('public/workspace-relay/google-oauth')
export class IdBusinessV2RelayScriptOAuthController {
  constructor(private readonly service: IdBusinessV2RelayScriptService) {}

  @Get('callback')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @SkipApiResponse()
  async callback(@Query() query: { code?: unknown; error?: unknown; state?: unknown }) {
    const succeeded = await this.service.completeGoogleAuthorization(query).catch(() => false);
    const title = succeeded ? 'Google Cloud 授权完成' : 'Google Cloud 授权失败';
    const detail = succeeded
      ? '中转脚本已经可以继续使用，请关闭此窗口。'
      : '授权状态无效或已过期，请关闭窗口后重新授权。';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:40px;color:#182230"><h1 style="font-size:20px">${title}</h1><p>${detail}</p></body></html>`;
  }
}
