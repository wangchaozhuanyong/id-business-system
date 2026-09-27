import { AxiosError, AxiosHeaders, CanceledError } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { http } from '@/api/client';
import { idBusinessV2WorkspaceApi } from './workspace';

function blobError(status: number, body: Blob) {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, undefined, {
    status,
    statusText: 'Failed',
    headers: {},
    config,
    data: body
  });
}

describe('media downloads', () => {
  it.each([
    [404, 'MEDIA_TICKET_EXPIRED', '下载凭证不存在或已过期，请重新解析'],
    [400, 'MEDIA_AUDIO_MISSING', '此视频不含音轨，无法下载原声；仍可下载视频'],
    [502, 'SERVICE_UNAVAILABLE', '来源平台暂时限制解析，请稍后重试']
  ])('preserves JSON error details from a %s blob response', async (status, code, message) => {
    vi.spyOn(http, 'get').mockRejectedValueOnce(
      blobError(
        status,
        new Blob([JSON.stringify({ errorCode: code, message, retryable: status === 502 })], {
          type: 'application/json'
        })
      )
    );
    await expect(idBusinessV2WorkspaceApi.downloadMedia('fixture')).rejects.toMatchObject({
      name: 'ApiError',
      code,
      message,
      status,
      retryable: status === 502
    });
  });

  it('maps proxy HTML failures to a retryable Chinese error', async () => {
    vi.spyOn(http, 'get').mockRejectedValueOnce(
      blobError(504, new Blob(['<html>Gateway Timeout</html>']))
    );
    await expect(idBusinessV2WorkspaceApi.downloadMedia('fixture')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'SERVICE_UNAVAILABLE',
      status: 504,
      retryable: true
    });
  });

  it('does not parse oversized error bodies', async () => {
    const blob = new Blob(['x'.repeat(65537)]);
    const read = vi.spyOn(blob, 'text');
    vi.spyOn(http, 'get').mockRejectedValueOnce(blobError(502, blob));
    await expect(idBusinessV2WorkspaceApi.downloadMedia('fixture')).rejects.toMatchObject({
      status: 502
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves cancellation', async () => {
    const canceled = new CanceledError();
    vi.spyOn(http, 'get').mockRejectedValueOnce(canceled);
    await expect(idBusinessV2WorkspaceApi.downloadMedia('fixture')).rejects.toBe(canceled);
  });

  it('returns successful media without parsing it', async () => {
    const data = new Blob(['fixture'], { type: 'video/mp4' });
    vi.spyOn(http, 'get').mockResolvedValueOnce({ data });
    await expect(idBusinessV2WorkspaceApi.downloadMedia('fixture')).resolves.toBe(data);
  });
});
