import { Body, Controller, Get, Header, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { CurrentUser } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { ResolveIdBusinessV2MediaDto } from './dto/id-business-v2-media-resolver.dto';
import { IdBusinessV2MediaResolverService } from './id-business-v2-media-resolver.service';

interface DownloadResponse {
  setHeader(name: string, value: string | number): void;
}

@Controller('id-business-v2/workspace-media')
export class IdBusinessV2MediaResolverController {
  constructor(private readonly service: IdBusinessV2MediaResolverService) {}

  @Post('resolve')
  @Header('Cache-Control', 'private, no-store')
  resolve(@Body() dto: ResolveIdBusinessV2MediaDto, @CurrentUser() operator?: AuthenticatedUser) {
    return this.service.resolve(dto, operator);
  }

  @Get('download')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Query('token') token: string,
    @CurrentUser() operator: AuthenticatedUser | undefined,
    @Res({ passthrough: true }) response: DownloadResponse
  ) {
    const file = await this.service.openDownload(token, operator);
    response.setHeader('Content-Length', file.contentLength);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.stream, {
      type: file.mimeType,
      length: file.contentLength,
      disposition: `attachment; filename="media.${file.filename.split('.').pop() ?? 'bin'}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`
    });
  }
}
