import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2MediaResolverService } from './id-business-v2-media-resolver.service';

const user = (id: string) => ({ id }) as AuthenticatedUser;

const workerResult = {
  title: '公开作品',
  author: '作者',
  durationSeconds: 12,
  mediaType: 'video',
  options: [
    {
      formatId: 'best',
      label: '最佳画质（自动合并）',
      extension: 'mp4',
      estimatedBytes: 1024,
      width: 1080,
      height: 1920,
      workerToken: 'w'.repeat(43)
    }
  ]
};

describe('IdBusinessV2MediaResolverService', () => {
  beforeEach(() => {
    process.env.ID_BUSINESS_V2_MEDIA_RESOLVER_URL = 'http://127.0.0.1:8787';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ID_BUSINESS_V2_MEDIA_RESOLVER_URL;
  });

  it('returns only user-bound opaque download tickets and no source URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(workerResult), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    const service = new IdBusinessV2MediaResolverService();

    const result = await service.resolve(
      { url: 'https://www.youtube.com/watch?v=public' },
      user('user-1')
    );

    expect(result).toMatchObject({
      platform: 'youtube',
      engine: 'yt-dlp',
      title: '公开作品'
    });
    expect(result.options[0].downloadToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(result)).not.toContain('youtube.com');
    expect(JSON.stringify(result)).not.toContain('w'.repeat(43));
    await expect(
      service.openDownload(result.options[0].downloadToken, user('user-2'))
    ).rejects.toThrow('下载凭证不存在或已过期');
  });

  it('streams a bounded worker download for the same authenticated user', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/resolve')) {
        return new Response(JSON.stringify(workerResult), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Length': '4', 'Content-Type': 'video/mp4' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new IdBusinessV2MediaResolverService();
    const result = await service.resolve(
      { url: 'https://www.youtube.com/watch?v=public' },
      user('user-1')
    );

    const file = await service.openDownload(result.options[0].downloadToken, user('user-1'));
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(file).toMatchObject({ contentLength: 4, mimeType: 'video/mp4' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const downloadRequest = (
      fetchMock.mock.calls as unknown as Array<[string | URL | Request, RequestInit?]>
    )[1]?.[1];
    expect(JSON.parse(String(downloadRequest?.body))).toMatchObject({
      workerToken: 'w'.repeat(43)
    });
  });

  it('keeps every album image and its music as individually typed downloads', async () => {
    const payload = {
      ...workerResult,
      mediaType: 'image',
      options: [
        ...Array.from({ length: 35 }, (_, index) => ({
          ...workerResult.options[0],
          formatId: `image:${index}`,
          mediaType: 'image',
          extension: 'jpg',
          label: `图片 ${index + 1}`
        })),
        {
          ...workerResult.options[0],
          formatId: 'audio',
          mediaType: 'audio',
          extension: 'mp3',
          label: '作品配乐'
        }
      ]
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/resolve')
        ? new Response(JSON.stringify(payload))
        : new Response(new Uint8Array([1, 2]), {
            headers: { 'Content-Length': '2', 'Content-Type': 'audio/mpeg' }
          })
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new IdBusinessV2MediaResolverService();
    const result = await service.resolve(
      { url: 'https://www.douyin.com/note/1234567890' },
      user('album-user')
    );
    expect(result.options).toHaveLength(36);
    expect(result.options.filter((option) => option.mediaType === 'image')).toHaveLength(35);
    expect(result.options[35]).toMatchObject({ mediaType: 'audio', extension: 'mp3' });
    const audio = await service.openDownload(result.options[35].downloadToken, user('album-user'));
    for await (const chunk of audio.stream) expect(chunk).toBeTruthy();
    expect(audio.mimeType).toBe('audio/mpeg');
    const request = (fetchMock.mock.calls as unknown as Array<[unknown, RequestInit]>)[1][1];
    expect(JSON.parse(String(request.body))).toMatchObject({ formatId: 'audio' });
  });

  it('rejects an oversized album instead of silently truncating it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...workerResult,
            options: Array.from({ length: 101 }, () => workerResult.options[0])
          })
        )
      )
    );
    await expect(
      new IdBusinessV2MediaResolverService().resolve(
        { url: 'https://www.youtube.com/watch?v=public' },
        user('user-1')
      )
    ).rejects.toThrow('最多支持 100 个文件');
  });

  it('requires a fresh resolve when the worker snapshot has expired', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(workerResult), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'ticket_expired' }), { status: 410 })
      );
    vi.stubGlobal('fetch', fetchMock);
    const service = new IdBusinessV2MediaResolverService();
    const result = await service.resolve(
      { url: 'https://www.youtube.com/watch?v=public' },
      user('user-1')
    );

    await expect(
      service.openDownload(result.options[0].downloadToken, user('user-1'))
    ).rejects.toThrow('下载凭证关联的解析结果已失效，请重新解析');
  });

  it('limits repeated resolves per user without storing them in the database', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () => new Response(JSON.stringify(workerResult), { status: 200 }))
    );
    const service = new IdBusinessV2MediaResolverService();

    for (let index = 0; index < 10; index += 1) {
      await service.resolve(
        { url: `https://www.youtube.com/watch?v=public${index}` },
        user('user-1')
      );
    }

    await expect(
      service.resolve({ url: 'https://www.youtube.com/watch?v=limited' }, user('user-1'))
    ).rejects.toThrow('解析过于频繁');
  });

  it.each([
    ['audio_missing', 400, 'MEDIA_AUDIO_MISSING'],
    ['ticket_expired', 410, 'MEDIA_TICKET_EXPIRED']
  ])('returns an actionable download code for %s', async (code, status, errorCode) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(workerResult)))
        .mockResolvedValueOnce(new Response(JSON.stringify({ code }), { status }))
    );
    const service = new IdBusinessV2MediaResolverService();
    const result = await service.resolve(
      { url: 'https://www.douyin.com/video/1234567890' },
      user('user-1')
    );
    await expect(
      service.openDownload(result.options[0].downloadToken, user('user-1'))
    ).rejects.toMatchObject({ response: { errorCode, retryable: false } });
  });

  it('marks missing or expired tickets for re-parsing without requesting the worker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new IdBusinessV2MediaResolverService().openDownload('m'.repeat(43), user('user-1'))
    ).rejects.toMatchObject({ response: { errorCode: 'MEDIA_TICKET_EXPIRED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['login_required', 400, '系统不会读取你的登录信息'],
    ['region_restricted', 400, '系统不会绕过平台限制'],
    ['platform_limited', 502, '来源平台暂时限制解析']
  ])('maps the worker %s state to a safe public message', async (code, status, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code }), {
          status,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    const service = new IdBusinessV2MediaResolverService();

    await expect(
      service.resolve({ url: 'https://www.youtube.com/watch?v=public' }, user(`user-${code}`))
    ).rejects.toThrow(message);
  });
});
