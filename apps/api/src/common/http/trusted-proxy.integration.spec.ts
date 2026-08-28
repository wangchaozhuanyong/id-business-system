import { Controller, Get, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import {
  configureProductionTrustedProxy,
  resolveTrustedClientIp,
  type RequestWithClientIp
} from './trusted-client-ip';

@Controller('trusted-proxy-test')
class TrustedProxyTestController {
  @Get()
  getClientIp(@Req() request: RequestWithClientIp) {
    return { ip: resolveTrustedClientIp(request) };
  }
}

describe('production trusted proxy integration', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TrustedProxyTestController]
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureProductionTrustedProxy(app, 'production');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('resolves the single forwarding value supplied by the adjacent Nginx hop', async () => {
    const response = await fetch(`${baseUrl}/trusted-proxy-test`, {
      headers: { 'x-forwarded-for': '203.0.113.25' }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ip: '203.0.113.25' });
  });
});
